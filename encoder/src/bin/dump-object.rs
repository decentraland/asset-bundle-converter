//! Dump the bytes of a specific class's first object from a real Unity
//! bundle. Used to inspect reference data field-by-field as we build
//! Value-graph builders for each Unity class.
//!
//! Usage:
//!   cargo run --bin dump-object --no-default-features -- <bundle> <class_id>
//!
//! Example:
//!   cargo run --bin dump-object --no-default-features -- /tmp/glb-bundle.assetbundle 33

use std::process::ExitCode;

use dcl_asset_bundle_encoder::encode::unityfs_writer::parse_bundle;

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().collect();
    if args.len() != 3 {
        eprintln!("usage: dump-object <bundle.assetbundle> <class_id>");
        return ExitCode::from(2);
    }
    let bundle_path = &args[1];
    let class_id: i32 = args[2].parse().expect("class_id must be integer");

    match run(bundle_path, class_id) {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => {
            eprintln!("[dump-object] FAILED: {e}");
            ExitCode::FAILURE
        }
    }
}

fn run(bundle_path: &str, class_id: i32) -> Result<(), String> {
    let bytes = std::fs::read(bundle_path).map_err(|e| format!("read {bundle_path}: {e}"))?;
    let parsed = parse_bundle(&bytes).map_err(|e| format!("UnityFS parse: {e}"))?;
    let sf_node = parsed
        .directory
        .iter()
        .find(|n| !n.path.ends_with(".resS"))
        .ok_or("no SerializedFile node")?;
    let sf =
        &parsed.data_payload_uncompressed[sf_node.offset as usize..(sf_node.offset + sf_node.size) as usize];

    // Parse the metadata's type table to find the type_index for our class.
    let metadata_size = i64::from_be_bytes(sf[0x10..0x18].try_into().unwrap()) as usize;
    let data_offset = i64::from_be_bytes(sf[0x20..0x28].try_into().unwrap()) as usize;
    let metadata = &sf[48..48 + metadata_size];

    let mut cur = metadata.iter().position(|&b| b == 0).unwrap() + 1; // unity_version
    cur += 4; // target_platform
    cur += 1; // enable_type_tree
    let type_count = i32::from_le_bytes(metadata[cur..cur + 4].try_into().unwrap()) as usize;
    cur += 4;

    let mut target_type_index: Option<i32> = None;
    for i in 0..type_count {
        let cid = i32::from_le_bytes(metadata[cur..cur + 4].try_into().unwrap());
        cur += 4;
        let _is_stripped = metadata[cur];
        cur += 1;
        let sti = i16::from_le_bytes(metadata[cur..cur + 2].try_into().unwrap());
        cur += 2;
        if sti >= 0 {
            cur += 16;
        }
        cur += 16; // old_type_hash
        let nc = u32::from_le_bytes(metadata[cur..cur + 4].try_into().unwrap()) as usize;
        let sb = u32::from_le_bytes(metadata[cur + 4..cur + 8].try_into().unwrap()) as usize;
        let blob_size_no_deps = 8 + nc * 32 + sb;
        let dep_off = cur + blob_size_no_deps;
        let dep_count = u32::from_le_bytes(metadata[dep_off..dep_off + 4].try_into().unwrap()) as usize;
        cur += blob_size_no_deps + 4 + dep_count * 4;
        if cid == class_id {
            target_type_index = Some(i as i32);
        }
    }
    let type_index = target_type_index
        .ok_or_else(|| format!("class {class_id} not in bundle"))?;

    // Walk the object table to find the first object with this type_index.
    let object_count = i32::from_le_bytes(metadata[cur..cur + 4].try_into().unwrap()) as usize;
    cur += 4;
    eprintln!("[dump-object] object_count={object_count}, type_index={type_index}, looking for class {class_id}");
    // Object entries are 4-byte aligned WITHIN THE METADATA — absolute
    // position alignment, not relative to where the object_count sits.
    // For bundles where object_count happens to land at a 4-aligned
    // metadata offset (texture bundle case), no extra padding. For
    // bundles where it doesn't (v49 glb has object_count at metadata
    // offset 20265, 1 mod 4), 3 bytes of padding are inserted before
    // the first entry.
    for i in 0..object_count {
        let pad = (4 - (cur % 4)) % 4;
        cur += pad;
        let path_id = i64::from_le_bytes(metadata[cur..cur + 8].try_into().unwrap());
        let byte_start = i64::from_le_bytes(metadata[cur + 8..cur + 16].try_into().unwrap());
        // byte_size encoding differs by Unity version:
        //   * Unity 2022.3.x texture bundles: u32 LE
        //   * Unity 6000.2.x bundles: u32 BE
        // Read both; pick whichever yields a sensible value (byte_start +
        // byte_size doesn't overrun the data section). Empirically the
        // BE form is what Unity 6 emits — verified against v49 glb where
        // BE = 68 for a 68-byte Transform.
        let bs_le = u32::from_le_bytes(metadata[cur + 16..cur + 20].try_into().unwrap());
        let bs_be = u32::from_be_bytes(metadata[cur + 16..cur + 20].try_into().unwrap());
        let byte_size = if bs_le < 100_000_000 { bs_le } else { bs_be };
        let ti = i32::from_le_bytes(metadata[cur + 20..cur + 24].try_into().unwrap());
        eprintln!("[dump-object]   obj[{i}]: path_id={path_id}, byte_start={byte_start}, byte_size={byte_size} (le={bs_le} be={bs_be}), ti={ti}");
        cur += 24;
        if ti == type_index {
            let abs_start = data_offset + byte_start as usize;
            let abs_end = abs_start + byte_size as usize;
            let obj = &sf[abs_start..abs_end];
            println!(
                "[dump-object] class {class_id}, object[{i}]: path_id={path_id}, size={byte_size}"
            );
            println!("[dump-object] {} bytes:", obj.len());
            hex_dump(obj);
            return Ok(());
        }
    }
    Err(format!("no object of class {class_id} found"))
}

fn hex_dump(bytes: &[u8]) {
    for (i, chunk) in bytes.chunks(16).enumerate() {
        let off = i * 16;
        let hex: String = chunk.iter().map(|b| format!("{b:02x} ")).collect();
        let ascii: String = chunk
            .iter()
            .map(|b| if (0x20..0x7f).contains(b) { *b as char } else { '.' })
            .collect();
        println!("  {off:04x}: {hex:<48} {ascii}");
    }
}
