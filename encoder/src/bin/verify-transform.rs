//! Verify the Transform writer (class 4).

use std::process::ExitCode;

use dcl_asset_bundle_encoder::encode::class_writers::{build_transform_value, PPtr, UnityTransform};
use dcl_asset_bundle_encoder::encode::serialized_file_reader::parse_serialized_file;
use dcl_asset_bundle_encoder::encode::type_tree::TypeTreeWriter;
use dcl_asset_bundle_encoder::encode::unityfs_writer::parse_bundle;

const TRANSFORM_CLASS_ID: i32 = 4;

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().collect();
    if args.len() != 2 {
        eprintln!("usage: verify-transform <bundle>");
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
    let db = match dcl_asset_bundle_encoder::encode::type_tree_db::load_fixture_with_class(
        TRANSFORM_CLASS_ID,
    ) {
        Some(db) => db,
        None => {
            eprintln!("[verify] no TypeTree fixture — run scripts/regenerate-fixtures.sh; skipping");
            return Ok(());
        }
    };
    let ref_bytes = std::fs::read(bundle_path).map_err(|e| format!("{e}"))?;
    let parsed = parse_bundle(&ref_bytes).map_err(|e| format!("{e}"))?;
    let sf_node = parsed.directory.iter().find(|n| !n.path.ends_with(".resS")).ok_or("no SF")?;
    let sf = &parsed.data_payload_uncompressed[sf_node.offset as usize..(sf_node.offset + sf_node.size) as usize];
    let ref_obj = extract_first_object_bytes(sf, TRANSFORM_CLASS_ID)?;
    eprintln!("[verify] reference Transform: {} bytes", ref_obj.len());

    // Parse the reference Transform bytes into a UnityTransform struct.
    // Layout (per TypeTree dump_class_tree -- 4):
    //   m_GameObject PPtr (file_id i32 + path_id i64 = 12 bytes)
    //   m_LocalRotation Quaternionf (4 floats = 16 bytes)
    //   m_LocalPosition Vector3f (3 floats = 12 bytes)
    //   m_LocalScale Vector3f (3 floats = 12 bytes)
    //   m_Children Array<PPtr> (size i32 + N*12 bytes)
    //   m_Father PPtr (12 bytes)
    let go = PPtr {
        file_id: i32::from_le_bytes(ref_obj[0..4].try_into().unwrap()),
        path_id: i64::from_le_bytes(ref_obj[4..12].try_into().unwrap()),
    };
    let rot = [
        f32::from_le_bytes(ref_obj[12..16].try_into().unwrap()),
        f32::from_le_bytes(ref_obj[16..20].try_into().unwrap()),
        f32::from_le_bytes(ref_obj[20..24].try_into().unwrap()),
        f32::from_le_bytes(ref_obj[24..28].try_into().unwrap()),
    ];
    let pos = [
        f32::from_le_bytes(ref_obj[28..32].try_into().unwrap()),
        f32::from_le_bytes(ref_obj[32..36].try_into().unwrap()),
        f32::from_le_bytes(ref_obj[36..40].try_into().unwrap()),
    ];
    let scl = [
        f32::from_le_bytes(ref_obj[40..44].try_into().unwrap()),
        f32::from_le_bytes(ref_obj[44..48].try_into().unwrap()),
        f32::from_le_bytes(ref_obj[48..52].try_into().unwrap()),
    ];
    let n_children = u32::from_le_bytes(ref_obj[52..56].try_into().unwrap()) as usize;
    let mut children = Vec::with_capacity(n_children);
    let mut off = 56;
    for _ in 0..n_children {
        children.push(PPtr {
            file_id: i32::from_le_bytes(ref_obj[off..off + 4].try_into().unwrap()),
            path_id: i64::from_le_bytes(ref_obj[off + 4..off + 12].try_into().unwrap()),
        });
        off += 12;
    }
    let father = PPtr {
        file_id: i32::from_le_bytes(ref_obj[off..off + 4].try_into().unwrap()),
        path_id: i64::from_le_bytes(ref_obj[off + 4..off + 12].try_into().unwrap()),
    };
    eprintln!("[verify] Transform: children={n_children}, pos={pos:?}, scale={scl:?}");

    let t = UnityTransform {
        game_object: go,
        local_rotation: rot,
        local_position: pos,
        local_scale: scl,
        children,
        father,
    };
    let value = build_transform_value(&t);
    let nodes = db.get(TRANSFORM_CLASS_ID).ok_or("class 4 not in fixture")?;
    let mut writer = TypeTreeWriter::new(nodes);
    writer.write_root(&value).map_err(|e| format!("write: {e}"))?;
    let our_bytes = writer.finish();
    eprintln!("[verify] our Transform:       {} bytes", our_bytes.len());

    if our_bytes == ref_obj {
        eprintln!("[verify] ✓ BYTE-EQUAL ✓");
        Ok(())
    } else {
        let min = our_bytes.len().min(ref_obj.len());
        for i in 0..min {
            if our_bytes[i] != ref_obj[i] {
                eprintln!("[verify] first diff at offset {i}: ref={:02x} ours={:02x}", ref_obj[i], our_bytes[i]);
                eprintln!("[verify] ref [{i}..]: {:02x?}", &ref_obj[i..i + 16.min(ref_obj.len() - i)]);
                eprintln!("[verify] ours[{i}..]: {:02x?}", &our_bytes[i..i + 16.min(our_bytes.len() - i)]);
                break;
            }
        }
        if our_bytes.len() != ref_obj.len() {
            eprintln!("[verify] length mismatch: ref={}, ours={}", ref_obj.len(), our_bytes.len());
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
    Err(format!("no object of class {class_id} found"))
}
