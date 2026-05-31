//! Generate an encoder bundle from a source glb and write it to disk, for
//! out-of-process validation (e.g. UnityPy / a Unity LoadFromFile spike).
//!
//! Usage: encode-glb-to-file <source.glb> <out.assetbundle> [windows|mac]

use std::process::ExitCode;
use dcl_asset_bundle_encoder::encode::bundle_assembler::{assemble_glb_graph, GlbGraphInput};
use dcl_asset_bundle_encoder::encode::gltf_material::{convert_glb_material, MaterialTextures};
use dcl_asset_bundle_encoder::encode::gltf_mesh::convert_glb_scene;
use dcl_asset_bundle_encoder::types::BuildTarget;

// DCL/Scene shader CABs per platform (see scene_encoder::shader_cab_path).
const CAB_WINDOWS: &str = "archive:/CAB-51fbd4c9d0fb3e603fd599ac9f5d01e1/CAB-51fbd4c9d0fb3e603fd599ac9f5d01e1";
const CAB_MAC: &str = "archive:/CAB-5ba4993b7ea166819a0af9aec5b25b8c/CAB-5ba4993b7ea166819a0af9aec5b25b8c";

fn main() -> ExitCode {
    let a: Vec<String> = std::env::args().collect();
    if a.len() < 3 {
        eprintln!("usage: encode-glb-to-file <source.glb> <out.assetbundle> [windows|mac] [root_name]");
        return ExitCode::from(2);
    }
    let (target, cab) = match a.get(3).map(|s| s.as_str()) {
        Some("mac") => (BuildTarget::Mac, CAB_MAC),
        _ => (BuildTarget::Windows, CAB_WINDOWS),
    };
    let root_name = a.get(4).cloned().unwrap_or_else(|| "encoded".to_string());
    match run(&a[1], &a[2], target, cab, &root_name) {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => { eprintln!("FAILED: {e}"); ExitCode::FAILURE }
    }
}

fn run(glb_path: &str, out: &str, target: BuildTarget, cab: &str, root_name: &str) -> Result<(), String> {
    let glb = std::fs::read(glb_path).map_err(|e| e.to_string())?;
    let scene = convert_glb_scene(&glb).map_err(|e| e.to_string())?;
    let jlen = u32::from_le_bytes(glb[12..16].try_into().unwrap()) as usize;
    let j: serde_json::Value = serde_json::from_slice(&glb[20..20 + jlen]).map_err(|e| e.to_string())?;
    let materials: Vec<_> = j["materials"].as_array()
        .map(|arr| (0..arr.len()).map(|i| convert_glb_material(&j, i, &MaterialTextures::default())).collect())
        .unwrap_or_default();

    // embedded base-color images
    let bin = &glb[20 + jlen + 8..];
    let textures = j["textures"].as_array();
    let images = j["images"].as_array();
    let bvs = j["bufferViews"].as_array();
    let mut base_color_image = Vec::new();
    let mut image_bytes: std::collections::HashMap<usize, Vec<u8>> = std::collections::HashMap::new();
    if let Some(mats) = j["materials"].as_array() {
        for m in mats {
            let img = m["pbrMetallicRoughness"]["baseColorTexture"]["index"].as_u64()
                .and_then(|ti| textures.and_then(|t| t.get(ti as usize))).and_then(|tx| tx["source"].as_u64()).map(|s| s as usize);
            base_color_image.push(img);
            if let Some(i) = img {
                if let Some(bv) = images.and_then(|im| im.get(i)).and_then(|im| im["bufferView"].as_u64()) {
                    if let Some(b) = bvs.and_then(|x| x.get(bv as usize)) {
                        let o = b["byteOffset"].as_u64().unwrap_or(0) as usize; let l = b["byteLength"].as_u64().unwrap_or(0) as usize;
                        if let Some(s) = bin.get(o..o + l) { image_bytes.insert(i, s.to_vec()); }
                    }
                }
            }
        }
    }

    let db = dcl_asset_bundle_encoder::encode::type_tree_db::load_fixture_with_class(43).ok_or("no TypeTree fixture (run scripts/regenerate-fixtures.sh)")?;
    let bundle = assemble_glb_graph(&db, target, &db.unity_version, &GlbGraphInput {
        bundle_name: "encoded_glb", root_name, content_filename: "asset.glb",
        scene: &scene, materials: &materials, base_color_image: &base_color_image, images: &image_bytes,
        shader_cab_path: cab, dependencies: &[], metadata_timestamp: 0,
    }).map_err(|e| format!("{e}"))?;
    std::fs::write(out, &bundle).map_err(|e| e.to_string())?;
    eprintln!("[encode] {} prims, {} images -> {} ({} bytes)", scene.total_primitives, image_bytes.len(), out, bundle.len());
    Ok(())
}
