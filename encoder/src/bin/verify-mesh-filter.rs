//! Verify the MeshFilter writer against a real Unity bundle.
//!
//! MeshFilter is the simplest of the visual components — just 2 PPtrs
//! (m_GameObject + m_Mesh) = 24 bytes total. If our writer produces
//! anything other than 24 bytes, the layout is wrong.
//!
//! Usage:
//!   cargo run --bin verify-mesh-filter --no-default-features -- <bundle>

use std::process::ExitCode;

use dcl_asset_bundle_encoder::encode::class_writers::{build_mesh_filter_value, UnityMeshFilter, PPtr};
use dcl_asset_bundle_encoder::encode::serialized_file_reader::parse_serialized_file;
use dcl_asset_bundle_encoder::encode::type_tree::TypeTreeWriter;
use dcl_asset_bundle_encoder::encode::unityfs_writer::parse_bundle;

const MESH_FILTER_CLASS_ID: i32 = 33;

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().collect();
    if args.len() != 2 {
        eprintln!("usage: verify-mesh-filter <bundle>");
        return ExitCode::from(2);
    }
    match run(&args[1]) {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => {
            eprintln!("FAILED: {e}");
            ExitCode::FAILURE
        }
    }
}

fn run(bundle_path: &str) -> Result<(), String> {
    // Load glb TypeTree fixture (includes class 33).
    let db = match dcl_asset_bundle_encoder::encode::type_tree_db::load_fixture_with_class(
        MESH_FILTER_CLASS_ID,
    ) {
        Some(db) => db,
        None => {
            eprintln!("[verify] no TypeTree fixture — run scripts/regenerate-fixtures.sh; skipping");
            return Ok(());
        }
    };

    // Parse the reference bundle.
    let ref_bytes = std::fs::read(bundle_path).map_err(|e| format!("read bundle: {e}"))?;
    let parsed = parse_bundle(&ref_bytes).map_err(|e| format!("UnityFS: {e}"))?;
    let sf_node = parsed.directory.iter().find(|n| !n.path.ends_with(".resS")).ok_or("no SF node")?;
    let sf = &parsed.data_payload_uncompressed[sf_node.offset as usize..(sf_node.offset + sf_node.size) as usize];

    // Find MeshFilter's object bytes via the metadata.
    let ref_obj = extract_first_object_bytes(sf, MESH_FILTER_CLASS_ID)?;
    eprintln!("[verify] reference MeshFilter: {} bytes", ref_obj.len());

    // Build our equivalent using fake PPtr values that match what's IN
    // the real object (so structurally byte-equal). MeshFilter holds
    // (m_GameObject PPtr, m_Mesh PPtr); we read both from the reference
    // and emit them through our writer.
    let go_file = i32::from_le_bytes(ref_obj[0..4].try_into().unwrap());
    let go_path = i64::from_le_bytes(ref_obj[4..12].try_into().unwrap());
    let mesh_file = i32::from_le_bytes(ref_obj[12..16].try_into().unwrap());
    let mesh_path = i64::from_le_bytes(ref_obj[16..24].try_into().unwrap());
    eprintln!(
        "[verify] PPtrs: GO=(file={go_file}, path={go_path:x}) Mesh=(file={mesh_file}, path={mesh_path:x})"
    );

    let mf = UnityMeshFilter {
        game_object: PPtr { file_id: go_file, path_id: go_path },
        mesh: PPtr { file_id: mesh_file, path_id: mesh_path },
    };
    let value = build_mesh_filter_value(&mf);

    let nodes = db.get(MESH_FILTER_CLASS_ID).ok_or("class 33 not in fixture")?;
    let mut writer = TypeTreeWriter::new(nodes);
    writer.write_root(&value).map_err(|e| format!("write: {e}"))?;
    let our_bytes = writer.finish();
    eprintln!("[verify] our MeshFilter:       {} bytes", our_bytes.len());

    // Byte-diff with identical inputs — if our writer is correct, they
    // should be byte-equal.
    if our_bytes == ref_obj {
        eprintln!("[verify] ✓ BYTE-EQUAL ✓");
        Ok(())
    } else {
        eprintln!("[verify] reference: {:02x?}", ref_obj);
        eprintln!("[verify] ours:      {:02x?}", our_bytes);
        for i in 0..our_bytes.len().min(ref_obj.len()) {
            if our_bytes[i] != ref_obj[i] {
                eprintln!("[verify] first diff at offset {i}: ref={:02x} ours={:02x}", ref_obj[i], our_bytes[i]);
                break;
            }
        }
        Err("output mismatch".into())
    }
}

fn extract_first_object_bytes(sf: &[u8], class_id: i32) -> Result<&[u8], String> {
    let parsed = parse_serialized_file(sf).map_err(|e| format!("parse SF: {e}"))?;
    let type_index = parsed.types.iter().position(|t| t.class_id == class_id).ok_or("class not in SF")?;

    let metadata_size = i64::from_be_bytes(sf[0x10..0x18].try_into().unwrap()) as usize;
    let data_offset = i64::from_be_bytes(sf[0x20..0x28].try_into().unwrap()) as usize;
    let metadata = &sf[48..48 + metadata_size];

    // Walk to object table (mirrors dump-object).
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
        let _path_id = i64::from_le_bytes(metadata[cur..cur + 8].try_into().unwrap());
        let byte_start = i64::from_le_bytes(metadata[cur + 8..cur + 16].try_into().unwrap()) as usize;
        let bs_le = u32::from_le_bytes(metadata[cur + 16..cur + 20].try_into().unwrap());
        let bs_be = u32::from_be_bytes(metadata[cur + 16..cur + 20].try_into().unwrap());
        let byte_size = if bs_le < 100_000_000 { bs_le as usize } else { bs_be as usize };
        let ti = i32::from_le_bytes(metadata[cur + 20..cur + 24].try_into().unwrap()) as usize;
        cur += 24;
        if ti == type_index {
            let abs_start = data_offset + byte_start;
            return Ok(&sf[abs_start..abs_start + byte_size]);
        }
    }
    Err(format!("no object of class {class_id} found"))
}
