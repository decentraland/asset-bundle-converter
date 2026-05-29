//! Verify the GameObject writer (class 1).

use std::process::ExitCode;

use dcl_asset_bundle_encoder::encode::class_writers::{build_game_object_value, PPtr, UnityGameObject};
use dcl_asset_bundle_encoder::encode::serialized_file_reader::parse_serialized_file;
use dcl_asset_bundle_encoder::encode::type_tree::TypeTreeWriter;
use dcl_asset_bundle_encoder::encode::unityfs_writer::parse_bundle;

const GAME_OBJECT_CLASS_ID: i32 = 1;

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().collect();
    if args.len() != 2 {
        eprintln!("usage: verify-game-object <bundle>");
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

fn run(path: &str) -> Result<(), String> {
    let db = match dcl_asset_bundle_encoder::encode::type_tree_db::load_fixture_with_class(
        GAME_OBJECT_CLASS_ID,
    ) {
        Some(db) => db,
        None => {
            eprintln!("[verify] no TypeTree fixture — run scripts/regenerate-fixtures.sh; skipping");
            return Ok(());
        }
    };
    let bytes = std::fs::read(path).map_err(|e| format!("{e}"))?;
    let parsed = parse_bundle(&bytes).map_err(|e| format!("{e}"))?;
    let sf_node = parsed.directory.iter().find(|n| !n.path.ends_with(".resS")).ok_or("no SF")?;
    let sf = &parsed.data_payload_uncompressed[sf_node.offset as usize..(sf_node.offset + sf_node.size) as usize];
    let ref_obj = extract_first_object_bytes(sf, GAME_OBJECT_CLASS_ID)?;
    eprintln!("[verify] reference GameObject: {} bytes", ref_obj.len());

    // Parse GameObject fields from reference bytes.
    // Layout: m_Component (Array<ComponentPair>) + m_Layer u32 +
    //         m_Name string + m_Tag u16 + m_IsActive bool.
    let mut off = 0;
    let n_comp = u32::from_le_bytes(ref_obj[off..off + 4].try_into().unwrap()) as usize;
    off += 4;
    let mut components = Vec::with_capacity(n_comp);
    for _ in 0..n_comp {
        // Each ComponentPair = PPtr (12 bytes: file_id i32 + path_id i64)
        components.push(PPtr {
            file_id: i32::from_le_bytes(ref_obj[off..off + 4].try_into().unwrap()),
            path_id: i64::from_le_bytes(ref_obj[off + 4..off + 12].try_into().unwrap()),
        });
        off += 12;
    }
    let layer = u32::from_le_bytes(ref_obj[off..off + 4].try_into().unwrap());
    off += 4;
    // m_Name string: length prefix + bytes + align-to-4
    let name_len = u32::from_le_bytes(ref_obj[off..off + 4].try_into().unwrap()) as usize;
    off += 4;
    let name = std::str::from_utf8(&ref_obj[off..off + name_len]).unwrap_or("").to_string();
    off += name_len;
    // align to 4 (string field has ALIGN flag)
    let pad = (4 - (off % 4)) % 4;
    off += pad;
    let tag = u16::from_le_bytes(ref_obj[off..off + 2].try_into().unwrap());
    off += 2;
    let is_active = ref_obj[off] != 0;
    eprintln!(
        "[verify] GameObject: name='{name}', components={n_comp}, layer={layer}, tag={tag}, active={is_active}"
    );

    let go = UnityGameObject {
        name,
        components,
        layer,
        tag,
        is_active,
    };
    let value = build_game_object_value(&go);
    let nodes = db.get(GAME_OBJECT_CLASS_ID).ok_or("class 1 not in fixture")?;
    let mut writer = TypeTreeWriter::new(nodes);
    writer.write_root(&value).map_err(|e| format!("write: {e}"))?;
    let our_bytes = writer.finish();
    eprintln!("[verify] our GameObject:       {} bytes", our_bytes.len());

    if our_bytes == ref_obj {
        eprintln!("[verify] ✓ BYTE-EQUAL ✓");
        Ok(())
    } else {
        let min = our_bytes.len().min(ref_obj.len());
        for i in 0..min {
            if our_bytes[i] != ref_obj[i] {
                eprintln!(
                    "[verify] first diff at offset {i}: ref={:02x} ours={:02x}",
                    ref_obj[i], our_bytes[i]
                );
                let s = i.saturating_sub(8);
                let e = (i + 16).min(min);
                eprintln!("[verify] ref [{s}..{e}]: {:02x?}", &ref_obj[s..e]);
                eprintln!("[verify] ours[{s}..{e}]: {:02x?}", &our_bytes[s..e]);
                break;
            }
        }
        if our_bytes.len() != ref_obj.len() {
            eprintln!("[verify] length: ref={} ours={}", ref_obj.len(), our_bytes.len());
        }
        Err("mismatch".into())
    }
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
