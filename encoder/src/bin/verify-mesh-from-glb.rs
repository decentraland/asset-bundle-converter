//! End-to-end geometry validation: convert every (mesh × primitive) in a
//! SOURCE glb via `encode::gltf_mesh::convert_glb_meshes` and match each, by
//! object bytes, against the REAL Unity Mesh objects in the converted bundle.
//!
//! Unity emits one Mesh object per glb primitive (a multi-primitive mesh
//! becomes several same-named objects), so we match on bytes (multiset),
//! not name.
//!
//! Usage: verify-mesh-from-glb <source.glb> <converted-bundle>

use std::process::ExitCode;
use dcl_asset_bundle_encoder::encode::class_writers::build_mesh_value;
use dcl_asset_bundle_encoder::encode::gltf_mesh::convert_glb_meshes;
use dcl_asset_bundle_encoder::encode::serialized_file_reader::parse_serialized_file;
use dcl_asset_bundle_encoder::encode::type_tree::TypeTreeWriter;
use dcl_asset_bundle_encoder::encode::unityfs_writer::parse_bundle;

fn main() -> ExitCode {
    let a: Vec<String> = std::env::args().collect();
    if a.len() != 3 { eprintln!("usage: verify-mesh-from-glb <source.glb> <bundle>"); return ExitCode::from(2); }
    match run(&a[1], &a[2]) { Ok(()) => ExitCode::SUCCESS, Err(e) => { eprintln!("FAILED: {e}"); ExitCode::FAILURE } }
}

fn run(glb_path: &str, bundle_path: &str) -> Result<(), String> {
    let meshes = convert_glb_meshes(&std::fs::read(glb_path).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    let db = dcl_asset_bundle_encoder::encode::type_tree_db::load_fixture_with_class(43).ok_or("no fixture")?;
    let nodes = db.get(43).unwrap();
    let bb = std::fs::read(bundle_path).map_err(|e| e.to_string())?;
    let pb = parse_bundle(&bb).map_err(|e| format!("{e}"))?;
    let n = pb.directory.iter().find(|n| !n.path.ends_with(".resS")).ok_or("no SF")?;
    let sf = &pb.data_payload_uncompressed[n.offset as usize..(n.offset + n.size) as usize];
    let real = extract_all(sf, 43)?;
    let mut used = vec![false; real.len()];

    let mut ok = 0usize; let mut bad = 0usize;
    for cm in &meshes {
        let mut w = TypeTreeWriter::new(nodes);
        w.write_root(&build_mesh_value(&cm.mesh)).map_err(|e| format!("{e}"))?;
        let our = w.finish();
        match real.iter().enumerate().position(|(i, r)| !used[i] && r == &our) {
            Some(i) => { used[i] = true; ok += 1; eprintln!("[✓] '{}' verts={} collider={} BYTE-EQUAL", cm.name, cm.mesh.vertex_count, cm.is_collider); }
            None => {
                bad += 1;
                eprintln!("[✗] '{}' verts={} collider={} ({}B) no byte-equal match", cm.name, cm.mesh.vertex_count, cm.is_collider, our.len());
                if let Some((_, r)) = real.iter().enumerate().find(|(i, r)| !used[*i] && r.len() == our.len()) {
                    let ndiff = (0..our.len()).filter(|&k| our[k] != r[k]).count();
                    eprintln!("     nearest same-len real differs in {ndiff} byte(s)");
                }
            }
        }
    }
    let leftover = used.iter().filter(|u| !**u).count();
    eprintln!("[summary] {ok}/{} our meshes matched; {bad} unmatched; {leftover} real meshes left over", meshes.len());
    if bad == 0 && leftover == 0 { Ok(()) } else { Err("mismatch".into()) }
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
