//! Validate encode::gltf_material::convert_glb_material against a real v49
//! Material, byte-for-byte (targets the "material_N" converter behaviour).
//!
//! Usage: verify-material-from-glb <source.glb> <bundle> [material_index]

use std::process::ExitCode;
use dcl_asset_bundle_encoder::encode::class_writers::build_material_value;
use dcl_asset_bundle_encoder::encode::gltf_material::{convert_glb_material, MaterialTextures};
use dcl_asset_bundle_encoder::encode::serialized_file_reader::parse_serialized_file;
use dcl_asset_bundle_encoder::encode::type_tree::TypeTreeWriter;
use dcl_asset_bundle_encoder::encode::unityfs_writer::parse_bundle;
use serde_json::Value as J;

fn main() -> ExitCode {
    let a: Vec<String> = std::env::args().collect();
    if a.len() < 3 { eprintln!("usage: verify-material-from-glb <glb> <bundle> [idx]"); return ExitCode::from(2); }
    let idx: usize = a.get(3).and_then(|s| s.parse().ok()).unwrap_or(0);
    match run(&a[1], &a[2], idx) { Ok(()) => ExitCode::SUCCESS, Err(e) => { eprintln!("FAILED: {e}"); ExitCode::FAILURE } }
}

fn run(glb: &str, bundle: &str, idx: usize) -> Result<(), String> {
    let d = std::fs::read(glb).map_err(|e| e.to_string())?;
    let jlen = u32::from_le_bytes(d[12..16].try_into().unwrap()) as usize;
    let j: J = serde_json::from_slice(&d[20..20 + jlen]).map_err(|e| e.to_string())?;
    let mat = convert_glb_material(&j, idx, &MaterialTextures::default());

    let db = dcl_asset_bundle_encoder::encode::type_tree_db::load_fixture_with_class(21).ok_or("no fixture")?;
    let nodes = db.get(21).unwrap();
    let mut w = TypeTreeWriter::new(nodes);
    w.write_root(&build_material_value(&mat)).map_err(|e| format!("{e}"))?;
    let our = w.finish();

    let bb = std::fs::read(bundle).map_err(|e| e.to_string())?;
    let pb = parse_bundle(&bb).map_err(|e| format!("{e}"))?;
    let n = pb.directory.iter().find(|n| !n.path.ends_with(".resS")).ok_or("no SF")?;
    let sf = &pb.data_payload_uncompressed[n.offset as usize..(n.offset + n.size) as usize];
    let reals = extract_all(sf, 21)?;
    eprintln!("[conv] material_{idx} our={}B; {} real material(s)", our.len(), reals.len());

    if reals.iter().any(|r| r == &our) { eprintln!("[verify] ✓ BYTE-EQUAL ✓"); return Ok(()); }
    if let Some(r) = reals.iter().find(|r| r.len() == our.len()) {
        let diffs: Vec<usize> = (0..our.len()).filter(|&k| our[k] != r[k]).collect();
        eprintln!("[verify] {} byte(s) differ at {:?} (untextured-opaque path)", diffs.len(), diffs);
    } else {
        eprintln!("[verify] no real material of length {} (have {:?})", our.len(), reals.iter().map(|r| r.len()).collect::<Vec<_>>());
    }
    Err("mismatch".into())
}

fn extract_all(sf: &[u8], class_id: i32) -> Result<Vec<Vec<u8>>, String> {
    let parsed = parse_serialized_file(sf).map_err(|e| format!("{e}"))?;
    let ti = parsed.types.iter().position(|t| t.class_id == class_id).ok_or("no class")? as i32;
    let ms = i64::from_be_bytes(sf[0x10..0x18].try_into().unwrap()) as usize;
    let dofs = i64::from_be_bytes(sf[0x20..0x28].try_into().unwrap()) as usize;
    let md = &sf[48..48 + ms];
    let mut cur = md.iter().position(|&x| x == 0).unwrap() + 1; cur += 5;
    let tc = i32::from_le_bytes(md[cur..cur + 4].try_into().unwrap()) as usize; cur += 4;
    for _ in 0..tc { cur += 4 + 1 + 2 + 16; let nc = u32::from_le_bytes(md[cur..cur + 4].try_into().unwrap()) as usize; let s = u32::from_le_bytes(md[cur + 4..cur + 8].try_into().unwrap()) as usize; let bs = 8 + nc * 32 + s; let dc = u32::from_le_bytes(md[cur + bs..cur + bs + 4].try_into().unwrap()) as usize; cur += bs + 4 + dc * 4; }
    let oc = i32::from_le_bytes(md[cur..cur + 4].try_into().unwrap()) as usize; cur += 4;
    let mut v = Vec::new();
    for _ in 0..oc { let pad = (4 - (cur % 4)) % 4; cur += pad; let bstart = i64::from_le_bytes(md[cur + 8..cur + 16].try_into().unwrap()) as usize; let bsl = u32::from_le_bytes(md[cur + 16..cur + 20].try_into().unwrap()) as usize; let t = i32::from_le_bytes(md[cur + 20..cur + 24].try_into().unwrap()); cur += 24; if t == ti { v.push(sf[dofs + bstart..dofs + bstart + bsl].to_vec()); } }
    Ok(v)
}
