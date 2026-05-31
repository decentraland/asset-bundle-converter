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

    let (material_images, image_bytes) =
        dcl_asset_bundle_encoder::encode::gltf_material::extract_material_images(&j, &glb);

    let db = dcl_asset_bundle_encoder::encode::type_tree_db::load_fixture_with_class(43).ok_or("no TypeTree fixture (run scripts/regenerate-fixtures.sh)")?;
    let bundle = assemble_glb_graph(&db, target, &db.unity_version, &GlbGraphInput {
        bundle_name: "encoded_glb", root_name, content_filename: "asset.glb",
        scene: &scene, materials: &materials, material_images: &material_images, images: &image_bytes,
        shader_cab_path: cab, dependencies: &[], metadata_timestamp: 0,
        // ANIM_METHOD overrides (legacy|mecanim|none); EMOTE=1 is shorthand for
        // mecanim (kept for the sweep harness). Default legacy.
        animation_method: {
            use dcl_asset_bundle_encoder::types::AnimationMethod;
            match std::env::var("ANIM_METHOD").ok().as_deref() {
                Some("mecanim") => AnimationMethod::Mecanim,
                Some("none") => AnimationMethod::None,
                Some("legacy") => AnimationMethod::Legacy,
                _ if std::env::var("EMOTE").as_deref() == Ok("1") => AnimationMethod::Mecanim,
                _ => AnimationMethod::Legacy,
            }
        },
    }).map_err(|e| format!("{e}"))?;
    std::fs::write(out, &bundle).map_err(|e| e.to_string())?;
    eprintln!("[encode] {} prims, {} images -> {} ({} bytes)", scene.total_primitives(), image_bytes.len(), out, bundle.len());
    Ok(())
}
