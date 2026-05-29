//! Extract TypeTree fixtures from a Unity-built AssetBundle.
//!
//! This is the answer to the bake step's "where do TypeTrees come from
//! when we don't have Unity?" question. Run it against any existing
//! Unity-built bundle on `ab-cdn.decentraland.org` (download with curl
//! or aws s3 cp first) and it produces `typetrees.bin` in the format
//! the encoder loads at startup.
//!
//! The bytes ARE the TypeTrees Unity put in the bundle. No Unity install,
//! no Unity license, no Python or .NET — just a Rust binary that reads
//! UnityFS + SerializedFile.
//!
//! Usage (output first, then one or more input bundles — merged):
//!   cargo run --bin extract-typetrees -- <output.bin> <bundle> [more...]
//!
//! Most users should run `scripts/regenerate-fixtures.sh`, which
//! discovers current production bundles and invokes this for you. The
//! fixtures are NOT committed (they encode Unity engine schemas — see
//! the Legal & Licensing section of README.md); regenerate them on
//! demand instead.
//!
//! A complete fixture needs BOTH a glb bundle (Mesh, Material,
//! GameObject, Transform, MeshFilter, MeshRenderer, AssetBundle, …) AND
//! a texture bundle (Texture2D lives only in its own bundle, since glbs
//! reference textures externally). Pass both; the type tables are merged
//! and deduped by class_id. All inputs must be the same Unity version.

use std::process::ExitCode;

use dcl_asset_bundle_encoder::catalyst_client; // re-exported; just to anchor the crate path
use dcl_asset_bundle_encoder::encode::serialized_file_reader::parse_serialized_file;
use dcl_asset_bundle_encoder::encode::typetree_fixture::{write_fixture, TypeTreeFixture};
use dcl_asset_bundle_encoder::encode::unityfs_writer::parse_bundle;

fn main() -> ExitCode {
    // Silence the unused-import warning for the catalyst_client anchor;
    // without it the binary doesn't pick up the crate's module surface
    // cleanly under some workspace layouts.
    let _ = std::mem::size_of::<catalyst_client::CatalystClient>();

    let args: Vec<String> = std::env::args().collect();
    if args.len() < 3 {
        eprintln!("usage: extract-typetrees <output.bin> <input.assetbundle> [more.assetbundle ...]");
        eprintln!();
        eprintln!("Read one or more Unity-built AssetBundles and emit a MERGED");
        eprintln!("TypeTree fixture (deduped by class_id) for the encoder to load");
        eprintln!("at startup. Pass a glb bundle AND a texture bundle to cover all");
        eprintln!("classes the encoder emits (textures live in their own bundles,");
        eprintln!("so Texture2D's TypeTree only appears in a texture bundle).");
        return ExitCode::from(2);
    }
    let output_path = &args[1];
    let input_paths = &args[2..];

    match run(output_path, input_paths) {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => {
            eprintln!("[extract-typetrees] FAILED: {e}");
            ExitCode::FAILURE
        }
    }
}

fn run(output_path: &str, input_paths: &[String]) -> Result<(), String> {
    use std::collections::BTreeMap;
    use dcl_asset_bundle_encoder::encode::serialized_file_reader::ExtractedTypeEntry;

    // Merge type entries across all input bundles, deduped by class_id
    // (first occurrence wins — all production bundles at one Unity
    // version share identical per-class TypeTrees).
    let mut merged: BTreeMap<i32, ExtractedTypeEntry> = BTreeMap::new();
    let mut unity_version: Option<String> = None;

    for input_path in input_paths {
        let bundle_bytes =
            std::fs::read(input_path).map_err(|e| format!("read {input_path}: {e}"))?;
        let parsed = parse_bundle(&bundle_bytes).map_err(|e| format!("UnityFS parse {input_path}: {e}"))?;

        let sf_node = parsed
            .directory
            .iter()
            .find(|n| !n.path.ends_with(".resS"))
            .ok_or_else(|| format!("{input_path}: no SerializedFile node (only .resS)"))?;
        let sf_start = sf_node.offset as usize;
        let sf_end = sf_start + sf_node.size as usize;
        if sf_end > parsed.data_payload_uncompressed.len() {
            return Err(format!("{input_path}: SerializedFile node range exceeds payload"));
        }
        let sf_bytes = &parsed.data_payload_uncompressed[sf_start..sf_end];
        let sf = parse_serialized_file(sf_bytes)
            .map_err(|e| format!("{input_path}: SerializedFile parse: {e}"))?;

        // All inputs must be the same Unity version — mixing versions in
        // one fixture would silently produce wrong layouts.
        match &unity_version {
            None => unity_version = Some(sf.unity_version.clone()),
            Some(v) if *v != sf.unity_version => {
                return Err(format!(
                    "Unity version mismatch: {input_path} is {} but earlier inputs were {v}. \
                     All inputs must be the same Unity version.",
                    sf.unity_version
                ));
            }
            _ => {}
        }

        let mut new_classes = Vec::new();
        for entry in sf.types {
            merged.entry(entry.class_id).or_insert_with(|| {
                new_classes.push(entry.class_id);
                entry
            });
        }
        eprintln!(
            "[extract-typetrees] {input_path}: unity={}, {} types ({} new: {new_classes:?})",
            sf.unity_version,
            merged.len(),
            new_classes.len()
        );
    }

    let unity_version = unity_version.ok_or("no input bundles produced any types")?;
    if merged.is_empty() {
        return Err("no TypeTree types found across inputs (DisableWriteTypeTree bundles?)".into());
    }

    let fixture = TypeTreeFixture {
        unity_version: unity_version.clone(),
        entries: merged.into_values().collect(),
    };
    let fixture_bytes = write_fixture(&fixture).map_err(|e| format!("fixture write: {e}"))?;

    if let Some(parent) = std::path::Path::new(output_path).parent() {
        if !parent.as_os_str().is_empty() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("create parent dir {}: {e}", parent.display()))?;
        }
    }
    std::fs::write(output_path, &fixture_bytes)
        .map_err(|e| format!("write {output_path}: {e}"))?;

    eprintln!(
        "[extract-typetrees] wrote {} bytes ({} classes, unity {}) to {}",
        fixture_bytes.len(),
        fixture.entries.len(),
        unity_version,
        output_path
    );
    eprintln!("[extract-typetrees] classes: {:?}", fixture.entries.iter().map(|e| e.class_id).collect::<Vec<_>>());
    Ok(())
}
