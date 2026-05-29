//! Universal per-class round-trip verifier.
//!
//! For a given class in a real bundle:
//!   1. Extract the object's bytes.
//!   2. Parse the class's TypeTree from the bundle's OWN embedded type
//!      table (so there's never a fixture-version mismatch).
//!   3. Read a `Value` tree from the bytes via `TypeTreeReader`.
//!   4. Confirm the read consumed exactly the object's byte span.
//!   5. Write the `Value` back via `TypeTreeWriter`.
//!   6. Require byte-identity with the original.
//!
//! This proves the writer reproduces real Unity object bytes for ANY
//! class without per-class hand-parsing. Run with no class_id to sweep
//! every class in the bundle.
//!
//! Usage:
//!   cargo run --bin verify-roundtrip --no-default-features -- <bundle> [class_id]

use std::process::ExitCode;

use dcl_asset_bundle_encoder::encode::serialized_file_reader::parse_serialized_file;
use dcl_asset_bundle_encoder::encode::type_tree::{parse_type_tree_nodes, TypeTreeReader, TypeTreeWriter};
use dcl_asset_bundle_encoder::encode::unityfs_writer::parse_bundle;

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().collect();
    if args.len() < 2 || args.len() > 3 {
        eprintln!("usage: verify-roundtrip <bundle> [class_id]");
        return ExitCode::from(2);
    }
    let only_class: Option<i32> = args.get(2).map(|s| s.parse().expect("class_id int"));
    match run(&args[1], only_class) {
        Ok(all_ok) => {
            if all_ok {
                ExitCode::SUCCESS
            } else {
                ExitCode::FAILURE
            }
        }
        Err(e) => {
            eprintln!("FAILED: {e}");
            ExitCode::FAILURE
        }
    }
}

fn run(bundle_path: &str, only_class: Option<i32>) -> Result<bool, String> {
    let bytes = std::fs::read(bundle_path).map_err(|e| format!("{e}"))?;
    let parsed = parse_bundle(&bytes).map_err(|e| format!("UnityFS: {e}"))?;
    let sf_node = parsed.directory.iter().find(|n| !n.path.ends_with(".resS")).ok_or("no SF")?;
    let sf = &parsed.data_payload_uncompressed[sf_node.offset as usize..(sf_node.offset + sf_node.size) as usize];

    let pf = parse_serialized_file(sf).map_err(|e| format!("SF parse: {e}"))?;
    eprintln!(
        "[roundtrip] {} (unity {}), {} types",
        bundle_path, pf.unity_version, pf.types.len()
    );

    let mut all_ok = true;
    for t in &pf.types {
        if let Some(c) = only_class {
            if t.class_id != c {
                continue;
            }
        }
        // Parse this class's TypeTree from the bundle's own blob.
        let nodes = match parse_type_tree_nodes(&t.type_tree_blob) {
            Ok(n) => n,
            Err(e) => {
                eprintln!("[roundtrip] class {:>4}: TypeTree parse FAILED: {e}", t.class_id);
                all_ok = false;
                continue;
            }
        };

        // Extract the object bytes for this class.
        let obj = match extract_first_object_bytes(sf, t.class_id) {
            Ok(o) => o,
            Err(_) => {
                // Type present in table but no object instance — skip.
                continue;
            }
        };

        // Read → check consumption → write → diff.
        let mut reader = TypeTreeReader::new(&nodes, obj);
        let value = match reader.read_root() {
            Ok(v) => v,
            Err(e) => {
                eprintln!("[roundtrip] class {:>4}: READ failed at pos {}: {e}", t.class_id, reader.position());
                all_ok = false;
                continue;
            }
        };
        let consumed = reader.position();
        if consumed != obj.len() {
            eprintln!(
                "[roundtrip] class {:>4}: READ consumed {consumed} of {} bytes ✗",
                t.class_id,
                obj.len()
            );
            all_ok = false;
            continue;
        }

        let mut writer = TypeTreeWriter::new(&nodes);
        if let Err(e) = writer.write_root(&value) {
            eprintln!("[roundtrip] class {:>4}: WRITE failed: {e}", t.class_id);
            all_ok = false;
            continue;
        }
        let out = writer.finish();

        if out == obj {
            eprintln!("[roundtrip] class {:>4}: ✓ BYTE-EQUAL ({} bytes)", t.class_id, obj.len());
        } else {
            all_ok = false;
            let min = out.len().min(obj.len());
            let mut first = None;
            for i in 0..min {
                if out[i] != obj[i] {
                    first = Some(i);
                    break;
                }
            }
            match first {
                Some(i) => eprintln!(
                    "[roundtrip] class {:>4}: ✗ first diff @{i} (ref={:02x} ours={:02x}), lens ref={} ours={}",
                    t.class_id, obj[i], out[i], obj.len(), out.len()
                ),
                None => eprintln!(
                    "[roundtrip] class {:>4}: ✗ length differs: ref={} ours={}",
                    t.class_id, obj.len(), out.len()
                ),
            }
        }
    }
    Ok(all_ok)
}

fn extract_first_object_bytes(sf: &[u8], class_id: i32) -> Result<&[u8], String> {
    let parsed = parse_serialized_file(sf).map_err(|e| format!("{e}"))?;
    let type_index = parsed.types.iter().position(|t| t.class_id == class_id).ok_or("not in SF")?;
    let metadata_size = i64::from_be_bytes(sf[0x10..0x18].try_into().unwrap()) as usize;
    let data_offset = i64::from_be_bytes(sf[0x20..0x28].try_into().unwrap()) as usize;
    let metadata = &sf[48..48 + metadata_size];
    let mut cur = metadata.iter().position(|&b| b == 0).unwrap() + 1;
    cur += 5;
    let tc = i32::from_le_bytes(metadata[cur..cur + 4].try_into().unwrap()) as usize;
    cur += 4;
    for _ in 0..tc {
        cur += 4 + 1 + 2 + 16;
        let nc = u32::from_le_bytes(metadata[cur..cur + 4].try_into().unwrap()) as usize;
        let sb = u32::from_le_bytes(metadata[cur + 4..cur + 8].try_into().unwrap()) as usize;
        let bs = 8 + nc * 32 + sb;
        let dc = u32::from_le_bytes(metadata[cur + bs..cur + bs + 4].try_into().unwrap()) as usize;
        cur += bs + 4 + dc * 4;
    }
    let object_count = i32::from_le_bytes(metadata[cur..cur + 4].try_into().unwrap()) as usize;
    cur += 4;
    for _ in 0..object_count {
        let pad = (4 - (cur % 4)) % 4;
        cur += pad;
        let byte_start = i64::from_le_bytes(metadata[cur + 8..cur + 16].try_into().unwrap()) as usize;
        let bs_le = u32::from_le_bytes(metadata[cur + 16..cur + 20].try_into().unwrap());
        let bs_be = u32::from_be_bytes(metadata[cur + 16..cur + 20].try_into().unwrap());
        let byte_size = if bs_le < 100_000_000 { bs_le as usize } else { bs_be as usize };
        let ti = i32::from_le_bytes(metadata[cur + 20..cur + 24].try_into().unwrap()) as usize;
        cur += 24;
        if ti == type_index {
            return Ok(&sf[data_offset + byte_start..data_offset + byte_start + byte_size]);
        }
    }
    Err(format!("class {class_id} not found"))
}
