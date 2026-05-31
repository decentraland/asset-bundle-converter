//! End-to-end: run the full glb→bundle graph pipeline and validate against
//! the real production bundle: (a) parses back; (b) the structural object
//! histogram (GameObject/Transform/MeshFilter/MeshRenderer/MeshCollider/Mesh)
//! matches Unity; (c) every emitted Mesh is byte-equal to production; (d) the
//! in-bundle Texture2D count is reported.
//!
//! Usage: verify-glb-encode <source.glb> <real-bundle>

use std::collections::{BTreeMap, HashMap};
use std::process::ExitCode;
use dcl_asset_bundle_encoder::encode::bundle_assembler::{assemble_glb_graph, GlbGraphInput};
use dcl_asset_bundle_encoder::encode::gltf_material::{convert_glb_material, MaterialTextures};
use dcl_asset_bundle_encoder::encode::gltf_mesh::convert_glb_scene;
use dcl_asset_bundle_encoder::encode::serialized_file_reader::parse_serialized_file;
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
    let scene = convert_glb_scene(&glb).map_err(|e| e.to_string())?;
    let jlen = u32::from_le_bytes(glb[12..16].try_into().unwrap()) as usize;
    let j: serde_json::Value = serde_json::from_slice(&glb[20..20 + jlen]).map_err(|e| e.to_string())?;
    let materials: Vec<_> = j["materials"].as_array().map(|a| (0..a.len()).map(|i| convert_glb_material(&j, i, &MaterialTextures::default())).collect()).unwrap_or_default();

    // per-material per-slot image indices + embedded image bytes.
    let (material_images, image_bytes) =
        dcl_asset_bundle_encoder::encode::gltf_material::extract_material_images(&j, &glb);

    let db = dcl_asset_bundle_encoder::encode::type_tree_db::load_fixture_with_class(43).ok_or("no fixture")?;
    let bundle = assemble_glb_graph(&db, BuildTarget::Windows, &db.unity_version, &GlbGraphInput {
        bundle_name: "test_windows", root_name: "testhash", content_filename: "test.glb",
        scene: &scene, materials: &materials, material_images: &material_images, images: &image_bytes,
        shader_cab_path: CAB, dependencies: &[], metadata_timestamp: 0,
    }).map_err(|e| format!("{e}"))?;
    eprintln!("[encode] {} nodes, {} prims, {} textures -> {} bytes", scene.roots.len(), scene.total_primitives(), image_bytes.len(), bundle.len());

    let (our_hist, our_meshes) = inspect(&bundle)?;
    let real = std::fs::read(bundle_path).map_err(|e| e.to_string())?;
    let (real_hist, real_meshes) = inspect(&real)?;
    eprintln!("[hist] ours: {our_hist:?}");
    eprintln!("[hist] real: {real_hist:?}");

    let mut ok = true;
    for c in [1, 4, 33, 23, 64, 43, 21, 28] {
        if our_hist.get(&c).copied().unwrap_or(0) != real_hist.get(&c).copied().unwrap_or(0) {
            eprintln!("[structural] MISMATCH class {c}: ours={} real={}", our_hist.get(&c).copied().unwrap_or(0), real_hist.get(&c).copied().unwrap_or(0)); ok = false;
        }
    }
    let mut matched = 0;
    for m in &our_meshes { if real_meshes.iter().any(|r| r == m) { matched += 1; } }
    eprintln!("[mesh] {}/{} emitted meshes byte-equal to production", matched, our_meshes.len());
    eprintln!("[tex] Texture2D: ours={} real={}", our_hist.get(&28).copied().unwrap_or(0), real_hist.get(&28).copied().unwrap_or(0));
    if matched != our_meshes.len() { ok = false; }

    if ok { eprintln!("[verify] ✓ graph structure matches + all meshes byte-equal ✓"); Ok(()) }
    else { Err("structural/mesh mismatch".into()) }
}

fn inspect(bundle: &[u8]) -> Result<(BTreeMap<i32, u32>, Vec<Vec<u8>>), String> {
    let pb = parse_bundle(bundle).map_err(|e| format!("{e}"))?;
    let n = pb.directory.iter().find(|n| !n.path.ends_with(".resS")).ok_or("no SF")?;
    let sf = &pb.data_payload_uncompressed[n.offset as usize..(n.offset + n.size) as usize];
    let _ = parse_serialized_file(sf).map_err(|e| format!("{e}"))?;
    let ms = i64::from_be_bytes(sf[0x10..0x18].try_into().unwrap()) as usize;
    let dofs = i64::from_be_bytes(sf[0x20..0x28].try_into().unwrap()) as usize;
    let md = &sf[48..48 + ms];
    let mut cur = md.iter().position(|&x| x == 0).unwrap() + 1; cur += 5;
    let tc = i32::from_le_bytes(md[cur..cur + 4].try_into().unwrap()) as usize; cur += 4;
    let mut idx2cls = vec![];
    for _ in 0..tc { let cid = i32::from_le_bytes(md[cur..cur + 4].try_into().unwrap()); idx2cls.push(cid); cur += 4 + 1 + 2 + 16; let nc = u32::from_le_bytes(md[cur..cur + 4].try_into().unwrap()) as usize; let sb = u32::from_le_bytes(md[cur + 4..cur + 8].try_into().unwrap()) as usize; let bs = 8 + nc * 32 + sb; let dc = u32::from_le_bytes(md[cur + bs..cur + bs + 4].try_into().unwrap()) as usize; cur += bs + 4 + dc * 4; }
    let oc = i32::from_le_bytes(md[cur..cur + 4].try_into().unwrap()) as usize; cur += 4;
    let mut hist = BTreeMap::new(); let mut meshes = vec![];
    for _ in 0..oc { let pad = (4 - (cur % 4)) % 4; cur += pad; let bstart = i64::from_le_bytes(md[cur + 8..cur + 16].try_into().unwrap()) as usize; let bsl = u32::from_le_bytes(md[cur + 16..cur + 20].try_into().unwrap()) as usize; let t = i32::from_le_bytes(md[cur + 20..cur + 24].try_into().unwrap()) as usize; cur += 24; let cid = idx2cls[t]; *hist.entry(cid).or_insert(0) += 1; if cid == 43 { meshes.push(sf[dofs + bstart..dofs + bstart + bsl].to_vec()); } }
    Ok((hist, meshes))
}
