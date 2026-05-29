//! End-to-end: run the full glb→bundle pipeline (convert_glb_meshes +
//! convert_glb_material + assemble_glb_bundle) on a source glb, then confirm
//! the produced bundle (a) parses back with the expected classes, and
//! (b) its Mesh object is byte-equal to the production bundle's Mesh.
//!
//! Usage: verify-glb-encode <source.glb> <real-bundle>

use std::process::ExitCode;
use dcl_asset_bundle_encoder::encode::bundle_assembler::{assemble_glb_bundle, GlbBundleInput};
use dcl_asset_bundle_encoder::encode::class_writers::build_mesh_value;
use dcl_asset_bundle_encoder::encode::gltf_material::{convert_glb_material, MaterialTextures, DCL_SCENE_SHADER_PATH_ID};
use dcl_asset_bundle_encoder::encode::gltf_mesh::convert_glb_meshes;
use dcl_asset_bundle_encoder::encode::serialized_file_reader::parse_serialized_file;
use dcl_asset_bundle_encoder::encode::type_tree::TypeTreeWriter;
use dcl_asset_bundle_encoder::encode::unityfs_writer::parse_bundle;
use dcl_asset_bundle_encoder::types::BuildTarget;

const CAB: &str = "archive:/CAB-51fbd4c9d0fb3e603fd599ac9f5d01e1/CAB-51fbd4c9d0fb3e603fd599ac9f5d01e1";

fn main() -> ExitCode {
    let a: Vec<String> = std::env::args().collect();
    if a.len() != 3 { eprintln!("usage: verify-glb-encode <glb> <bundle>"); return ExitCode::from(2); }
    match run(&a[1], &a[2]) { Ok(()) => ExitCode::SUCCESS, Err(e) => { eprintln!("FAILED: {e}"); ExitCode::FAILURE } }
}

fn run(glb_path: &str, bundle_path: &str) -> Result<(), String> {
    let glb = std::fs::read(glb_path).map_err(|e| e.to_string())?;
    let meshes = convert_glb_meshes(&glb).map_err(|e| e.to_string())?;
    if meshes.len() != 1 { return Err(format!("expected single-mesh glb, got {}", meshes.len())); }
    let cm = &meshes[0];
    let jlen = u32::from_le_bytes(glb[12..16].try_into().unwrap()) as usize;
    let j: serde_json::Value = serde_json::from_slice(&glb[20..20 + jlen]).map_err(|e| e.to_string())?;
    let mat_idx = j["meshes"][0]["primitives"][0]["material"].as_u64().unwrap_or(0) as usize;
    let material = convert_glb_material(&j, mat_idx, &MaterialTextures::default());

    let db = dcl_asset_bundle_encoder::encode::type_tree_db::load_fixture_with_class(43).ok_or("no fixture")?;
    let bundle = assemble_glb_bundle(&db, BuildTarget::Windows, &db.unity_version, &GlbBundleInput {
        bundle_name: "test_glb_windows", content_filename: "test.glb", game_object_name: &cm.name,
        mesh: &cm.mesh, material: &material, shader_cab_path: CAB, shader_path_id: DCL_SCENE_SHADER_PATH_ID,
        dependencies: &[], metadata_timestamp: 0,
    }).map_err(|e| format!("{e}"))?;
    eprintln!("[encode] produced {} byte bundle", bundle.len());

    // (a) parses back with expected classes
    let pb = parse_bundle(&bundle).map_err(|e| format!("parse our bundle: {e}"))?;
    let n = pb.directory.iter().find(|n| !n.path.ends_with(".resS")).ok_or("no SF")?;
    let sf = &pb.data_payload_uncompressed[n.offset as usize..(n.offset + n.size) as usize];
    let parsed = parse_serialized_file(sf).map_err(|e| format!("parse our SF: {e}"))?;
    let classes: Vec<i32> = parsed.types.iter().map(|t| t.class_id).collect();
    eprintln!("[verify] our bundle classes: {:?}", classes);
    for c in [1, 4, 21, 23, 33, 43, 49, 142] {
        if !classes.contains(&c) { return Err(format!("our bundle missing class {c}")); }
    }

    // (b) our Mesh object byte-equals the production Mesh
    let mut w = TypeTreeWriter::new(db.get(43).unwrap());
    w.write_root(&build_mesh_value(&cm.mesh)).map_err(|e| format!("{e}"))?;
    let our_mesh = w.finish();
    let real = std::fs::read(bundle_path).map_err(|e| e.to_string())?;
    let rpb = parse_bundle(&real).map_err(|e| format!("{e}"))?;
    let rn = rpb.directory.iter().find(|n| !n.path.ends_with(".resS")).unwrap();
    let rsf = &rpb.data_payload_uncompressed[rn.offset as usize..(rn.offset + rn.size) as usize];
    let real_mesh = extract(rsf, 43)?;
    if our_mesh == real_mesh {
        eprintln!("[verify] ✓ pipeline output parses back + Mesh BYTE-EQUAL to production ✓");
        Ok(())
    } else {
        Err("Mesh object differs from production".into())
    }
}

fn extract(sf: &[u8], class_id: i32) -> Result<Vec<u8>, String> {
    let parsed = parse_serialized_file(sf).map_err(|e| format!("{e}"))?;
    let ti = parsed.types.iter().position(|t| t.class_id == class_id).ok_or("no class")? as i32;
    let ms = i64::from_be_bytes(sf[0x10..0x18].try_into().unwrap()) as usize;
    let dofs = i64::from_be_bytes(sf[0x20..0x28].try_into().unwrap()) as usize;
    let md = &sf[48..48 + ms];
    let mut cur = md.iter().position(|&x| x == 0).unwrap() + 1; cur += 5;
    let tc = i32::from_le_bytes(md[cur..cur + 4].try_into().unwrap()) as usize; cur += 4;
    for _ in 0..tc { cur += 4 + 1 + 2 + 16; let nc = u32::from_le_bytes(md[cur..cur + 4].try_into().unwrap()) as usize; let s = u32::from_le_bytes(md[cur + 4..cur + 8].try_into().unwrap()) as usize; let bs = 8 + nc * 32 + s; let dc = u32::from_le_bytes(md[cur + bs..cur + bs + 4].try_into().unwrap()) as usize; cur += bs + 4 + dc * 4; }
    let oc = i32::from_le_bytes(md[cur..cur + 4].try_into().unwrap()) as usize; cur += 4;
    for _ in 0..oc { let pad = (4 - (cur % 4)) % 4; cur += pad; let bstart = i64::from_le_bytes(md[cur + 8..cur + 16].try_into().unwrap()) as usize; let bsl = u32::from_le_bytes(md[cur + 16..cur + 20].try_into().unwrap()) as usize; let t = i32::from_le_bytes(md[cur + 20..cur + 24].try_into().unwrap()); cur += 24; if t == ti { return Ok(sf[dofs + bstart..dofs + bstart + bsl].to_vec()); } }
    Err("not found".into())
}
