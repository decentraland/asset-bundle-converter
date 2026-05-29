//! Assembles complete, loadable UnityFS bundles from class objects.
//!
//! A bundle the Explorer can `LoadAsset` from needs more than the raw
//! content object — it needs:
//!   * the content object(s) (Texture2D, or the glb's GameObject graph),
//!   * a `metadata.json` TextAsset carrying the dependency list,
//!   * an AssetBundle root object whose `m_Container` maps asset paths to
//!     those objects (this is what name-based loads resolve against).
//!
//! Verified shape against real production bundles via `dump-fields`:
//! a texture bundle is exactly { Texture2D, TextAsset, AssetBundle }.
//!
//! Path-ID assignment is internal and arbitrary as long as the object
//! table and the PPtrs that reference it agree. We use small sequential
//! IDs (AssetBundle=1, content=2, metadata=3); Unity uses hash-style IDs
//! but the loader only requires internal consistency.

use crate::encode::class_writers::{
    build_asset_bundle_value, build_game_object_value, build_material_value, build_mesh_filter_value,
    build_mesh_renderer_value, build_mesh_value, build_text_asset_value, build_transform_value,
    AssetBundleEntry, AssetInfo, PPtr, UnityAssetBundle, UnityGameObject, UnityMaterial,
    UnityMeshFilter, UnityMeshObject, UnityMeshRenderer, UnityTransform,
};
use crate::encode::serialized_file::{
    unity_target_id_for, write_serialized_file, ExternalEntry, ObjectEntry, SerializedFileInput,
    TypeEntry,
};
use crate::encode::texture_writer::{decode_to_texture2d, serialize_texture2d};
use crate::encode::type_tree::{TypeTreeWriter, Value};
use crate::encode::type_tree_db::TypeTreeDb;
use crate::encode::unityfs_writer::{write_bundle, DirectoryNode, UnityFsWriteOptions};
use crate::encode::SerializeError;
use crate::types::BuildTarget;

pub const CLASS_GAMEOBJECT: i32 = 1;
pub const CLASS_TRANSFORM: i32 = 4;
pub const CLASS_MATERIAL: i32 = 21;
pub const CLASS_MESHRENDERER: i32 = 23;
pub const CLASS_TEXTURE2D: i32 = 28;
pub const CLASS_MESHFILTER: i32 = 33;
pub const CLASS_MESH: i32 = 43;
pub const CLASS_TEXTASSET: i32 = 49;
pub const CLASS_ASSETBUNDLE: i32 = 142;

// Conventional path IDs for the assembled objects.
const PATH_ID_ASSETBUNDLE: i64 = 1;
const PATH_ID_CONTENT: i64 = 2;
const PATH_ID_METADATA: i64 = 3;

/// One object queued for the SerializedFile, paired with its class so we
/// can build the type table.
struct PreparedObject {
    class_id: i32,
    path_id: i64,
    data: Vec<u8>,
}

/// Serialise the bundle's metadata.json content. Mirrors the shape the
/// Unity converter emits (`AssetBundleMetadataBuilder`): version,
/// timestamp, dependency CID list, mainAsset. Timestamp is caller-
/// supplied for determinism (the encoder passes a stable value, not a
/// wall clock).
pub fn metadata_json(version: &str, timestamp: i64, dependencies: &[String], main_asset: &str) -> String {
    let deps = dependencies
        .iter()
        .map(|d| format!("\"{d}\""))
        .collect::<Vec<_>>()
        .join(",");
    format!(
        "{{\"timestamp\":{timestamp},\"version\":\"{version}\",\"dependencies\":[{deps}],\"mainAsset\":\"{main_asset}\"}}"
    )
}

/// Assemble a complete texture bundle from decoded PNG/JPG bytes.
///
/// `content_filename` is the asset path key used in m_Container (Unity
/// uses the original content filename, e.g. "<hash>.png"); `bundle_name`
/// is `{hash}{platform_suffix}`.
#[allow(clippy::too_many_arguments)]
pub fn assemble_texture_bundle(
    db: &TypeTreeDb,
    target: BuildTarget,
    unity_version: &str,
    bundle_name: &str,
    content_filename: &str,
    image_bytes: &[u8],
    metadata_timestamp: i64,
) -> Result<Vec<u8>, SerializeError> {
    // 1. Texture2D content object.
    let tex = decode_to_texture2d(bundle_name, image_bytes)?;
    let tex_bytes = serialize_texture2d(&tex, db)?;

    // 2. metadata.json TextAsset (textures are leaves — empty deps).
    let meta = metadata_json("7.0", metadata_timestamp, &[], "");
    let meta_bytes = serialize_class(db, CLASS_TEXTASSET, &build_text_asset_value("metadata", &meta))?;

    // 3. AssetBundle root referencing both.
    let ab = UnityAssetBundle {
        name: bundle_name.to_string(),
        preload_table: vec![
            PPtr { file_id: 0, path_id: PATH_ID_CONTENT },
            PPtr { file_id: 0, path_id: PATH_ID_METADATA },
        ],
        container: vec![
            AssetBundleEntry {
                asset_path: content_filename.to_string(),
                preload_index: 0,
                preload_size: 1,
                asset_pptr: PPtr { file_id: 0, path_id: PATH_ID_CONTENT },
            },
            AssetBundleEntry {
                asset_path: "metadata.json".to_string(),
                preload_index: 1,
                preload_size: 1,
                asset_pptr: PPtr { file_id: 0, path_id: PATH_ID_METADATA },
            },
        ],
        main_asset: AssetInfo::default(),
        runtime_compatibility: 1,
        asset_bundle_name: bundle_name.to_string(),
        dependencies: vec![],
        is_streamed_scene: false,
        explicit_data_layout: 1,
        path_flags: 0,
        scene_hashes: vec![],
    };
    let ab_bytes = serialize_class(db, CLASS_ASSETBUNDLE, &build_asset_bundle_value(&ab))?;

    let objects = vec![
        PreparedObject { class_id: CLASS_TEXTURE2D, path_id: PATH_ID_CONTENT, data: tex_bytes },
        PreparedObject { class_id: CLASS_TEXTASSET, path_id: PATH_ID_METADATA, data: meta_bytes },
        PreparedObject { class_id: CLASS_ASSETBUNDLE, path_id: PATH_ID_ASSETBUNDLE, data: ab_bytes },
    ];

    assemble_unityfs(db, target, unity_version, bundle_name, objects, &[])
}

/// Inputs for assembling a glb bundle's component graph. The mesh and
/// material are the byte-proven serialized forms; the semantic
/// glTF→{UnityMeshObject,UnityMaterial} conversion lives upstream and is
/// the render-gated piece (this layer is structurally verifiable).
pub struct GlbBundleInput<'a> {
    pub bundle_name: &'a str,
    /// Asset-path key for m_Container (Unity uses the glb content path).
    pub content_filename: &'a str,
    pub game_object_name: &'a str,
    pub mesh: &'a UnityMeshObject,
    pub material: &'a UnityMaterial,
    /// The DCL/Scene shader external (CAB path + the Material's m_Shader
    /// path_id). Verified constant across v49 bundles; see CLAUDE.md.
    pub shader_cab_path: &'a str,
    pub shader_path_id: i64,
    /// Per-glb dependency CIDs for metadata.json (textures/buffers).
    pub dependencies: &'a [String],
    pub metadata_timestamp: i64,
}

// Path-ID layout for the assembled glb graph. Internal + arbitrary; only
// internal consistency (PPtrs ↔ object table) matters to the loader.
const GLB_PATH_ASSETBUNDLE: i64 = 1;
const GLB_PATH_GAMEOBJECT: i64 = 2;
const GLB_PATH_TRANSFORM: i64 = 3;
const GLB_PATH_MESHFILTER: i64 = 4;
const GLB_PATH_MESHRENDERER: i64 = 5;
const GLB_PATH_MESH: i64 = 6;
const GLB_PATH_MATERIAL: i64 = 7;
const GLB_PATH_METADATA: i64 = 8;

/// file_id=1 → externals[0] (the shader bundle); file_id=0 → this file.
const FILE_ID_SHADER_EXTERNAL: i32 = 1;

/// Assemble a complete glb bundle: GameObject + Transform + MeshFilter +
/// MeshRenderer + Mesh + Material + metadata.json + AssetBundle, with the
/// DCL/Scene shader registered as a SerializedFile external. The emitted
/// bundle is structurally self-consistent (parses back through our reader)
/// — NOT byte-equal to Unity's output (path-IDs / object order differ).
/// Rendering correctness is gated on the Explorer-load spike.
pub fn assemble_glb_bundle(
    db: &TypeTreeDb,
    target: BuildTarget,
    unity_version: &str,
    input: &GlbBundleInput,
) -> Result<Vec<u8>, SerializeError> {
    let here = |path_id: i64| PPtr { file_id: 0, path_id };

    // GameObject — owns Transform + MeshFilter + MeshRenderer.
    let go = UnityGameObject {
        name: input.game_object_name.to_string(),
        components: vec![
            here(GLB_PATH_TRANSFORM),
            here(GLB_PATH_MESHFILTER),
            here(GLB_PATH_MESHRENDERER),
        ],
        layer: 0,
        tag: 0,
        is_active: true,
    };
    let go_bytes = serialize_class(db, CLASS_GAMEOBJECT, &build_game_object_value(&go))?;

    // Transform — identity local transform, parented to no one.
    let tr = UnityTransform {
        game_object: here(GLB_PATH_GAMEOBJECT),
        local_rotation: [0.0, 0.0, 0.0, 1.0],
        local_position: [0.0, 0.0, 0.0],
        local_scale: [1.0, 1.0, 1.0],
        children: vec![],
        father: PPtr::default(),
    };
    let tr_bytes = serialize_class(db, CLASS_TRANSFORM, &build_transform_value(&tr))?;

    // MeshFilter — links the GameObject to the Mesh.
    let mf = UnityMeshFilter {
        game_object: here(GLB_PATH_GAMEOBJECT),
        mesh: here(GLB_PATH_MESH),
    };
    let mf_bytes = serialize_class(db, CLASS_MESHFILTER, &build_mesh_filter_value(&mf))?;

    // MeshRenderer — static-mesh defaults; m_Materials = [Material].
    let mr = UnityMeshRenderer {
        game_object: here(GLB_PATH_GAMEOBJECT),
        enabled: 1,
        cast_shadows: 1,
        receive_shadows: 1,
        dynamic_occludee: 1,
        lightmap_index: 0xFFFF,
        lightmap_index_dynamic: 0xFFFF,
        materials: vec![here(GLB_PATH_MATERIAL)],
        ..Default::default()
    };
    let mr_bytes = serialize_class(db, CLASS_MESHRENDERER, &build_mesh_renderer_value(&mr))?;

    // Mesh + Material (byte-proven serialized forms). The Material's
    // m_Shader is forced to reference the external shader bundle.
    let mesh_bytes = serialize_class(db, CLASS_MESH, &build_mesh_value(input.mesh))?;
    let mut material = input.material.clone();
    material.shader = PPtr { file_id: FILE_ID_SHADER_EXTERNAL, path_id: input.shader_path_id };
    let mat_bytes = serialize_class(db, CLASS_MATERIAL, &build_material_value(&material))?;

    // metadata.json TextAsset (per-glb dep CID list; mainAsset = GameObject path).
    let meta = metadata_json("7.0", input.metadata_timestamp, input.dependencies, input.content_filename);
    let meta_bytes = serialize_class(db, CLASS_TEXTASSET, &build_text_asset_value("metadata", &meta))?;

    // AssetBundle root — main asset is the GameObject prefab.
    let ab = UnityAssetBundle {
        name: input.bundle_name.to_string(),
        preload_table: vec![
            here(GLB_PATH_GAMEOBJECT),
            here(GLB_PATH_TRANSFORM),
            here(GLB_PATH_MESHFILTER),
            here(GLB_PATH_MESHRENDERER),
            here(GLB_PATH_MESH),
            here(GLB_PATH_MATERIAL),
            here(GLB_PATH_METADATA),
        ],
        container: vec![
            AssetBundleEntry {
                asset_path: input.content_filename.to_string(),
                preload_index: 0,
                preload_size: 6,
                asset_pptr: here(GLB_PATH_GAMEOBJECT),
            },
            AssetBundleEntry {
                asset_path: "metadata.json".to_string(),
                preload_index: 6,
                preload_size: 1,
                asset_pptr: here(GLB_PATH_METADATA),
            },
        ],
        main_asset: AssetInfo::default(),
        runtime_compatibility: 1,
        asset_bundle_name: input.bundle_name.to_string(),
        dependencies: vec![],
        is_streamed_scene: false,
        explicit_data_layout: 1,
        path_flags: 0,
        scene_hashes: vec![],
    };
    let ab_bytes = serialize_class(db, CLASS_ASSETBUNDLE, &build_asset_bundle_value(&ab))?;

    let objects = vec![
        PreparedObject { class_id: CLASS_GAMEOBJECT, path_id: GLB_PATH_GAMEOBJECT, data: go_bytes },
        PreparedObject { class_id: CLASS_TRANSFORM, path_id: GLB_PATH_TRANSFORM, data: tr_bytes },
        PreparedObject { class_id: CLASS_MESHFILTER, path_id: GLB_PATH_MESHFILTER, data: mf_bytes },
        PreparedObject { class_id: CLASS_MESHRENDERER, path_id: GLB_PATH_MESHRENDERER, data: mr_bytes },
        PreparedObject { class_id: CLASS_MESH, path_id: GLB_PATH_MESH, data: mesh_bytes },
        PreparedObject { class_id: CLASS_MATERIAL, path_id: GLB_PATH_MATERIAL, data: mat_bytes },
        PreparedObject { class_id: CLASS_TEXTASSET, path_id: GLB_PATH_METADATA, data: meta_bytes },
        PreparedObject { class_id: CLASS_ASSETBUNDLE, path_id: GLB_PATH_ASSETBUNDLE, data: ab_bytes },
    ];

    let externals = [ExternalEntry {
        guid: [0u8; 16],
        type_id: 0,
        path: input.shader_cab_path.to_string(),
    }];

    assemble_unityfs(db, target, unity_version, input.bundle_name, objects, &externals)
}

/// Serialize one class's Value through its TypeTree from the db.
fn serialize_class(db: &TypeTreeDb, class_id: i32, value: &Value) -> Result<Vec<u8>, SerializeError> {
    let nodes = db.get(class_id).ok_or_else(|| {
        SerializeError::Format(format!("class {class_id} missing from TypeTree fixture"))
    })?;
    let mut w = TypeTreeWriter::new(nodes);
    w.write_root(value)?;
    Ok(w.finish())
}

/// Build the SerializedFile (type table + object table + object data)
/// from prepared objects and wrap it in a UnityFS archive.
fn assemble_unityfs(
    db: &TypeTreeDb,
    target: BuildTarget,
    unity_version: &str,
    bundle_name: &str,
    objects: Vec<PreparedObject>,
    externals: &[ExternalEntry],
) -> Result<Vec<u8>, SerializeError> {
    // Build the type table: one entry per distinct class, carrying the
    // class's embedded TypeTree blob + old_type_hash from the fixture.
    let mut type_entries: Vec<TypeEntry> = Vec::new();
    let mut class_to_type_index: std::collections::HashMap<i32, i32> = std::collections::HashMap::new();
    for obj in &objects {
        if class_to_type_index.contains_key(&obj.class_id) {
            continue;
        }
        let meta = db.meta(obj.class_id).ok_or_else(|| {
            SerializeError::Format(format!("class {} meta missing from fixture", obj.class_id))
        })?;
        class_to_type_index.insert(obj.class_id, type_entries.len() as i32);
        type_entries.push(TypeEntry {
            class_id: obj.class_id,
            is_stripped: meta.is_stripped,
            script_id: meta.script_id,
            old_type_hash: meta.old_type_hash,
            type_tree_blob: meta.raw_blob.clone(),
        });
    }

    let object_entries: Vec<ObjectEntry> = objects
        .iter()
        .map(|o| ObjectEntry {
            path_id: o.path_id,
            type_index: class_to_type_index[&o.class_id],
            data: o.data.clone(),
        })
        .collect();

    let sf_bytes = write_serialized_file(&SerializedFileInput {
        unity_version,
        target_platform: unity_target_id_for(target),
        types: type_entries,
        objects: object_entries,
        externals: externals.to_vec(),
    })?;

    let _ = bundle_name; // reserved for CAB naming if we diverge from the hash
    write_bundle(UnityFsWriteOptions {
        unity_revision: unity_version,
        nodes: vec![DirectoryNode::serialized_file(sf_bytes)],
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn load_glb_db() -> Option<TypeTreeDb> {
        // A texture bundle needs Texture2D + TextAsset + AssetBundle.
        // load_fixture_with_class(28) returns a fixture containing
        // Texture2D; a merged fixture (regenerate-fixtures.sh) also has
        // TextAsset + AssetBundle. Returns None when no fixture present
        // (gitignored — regenerated on demand), so the test skips.
        let db = crate::encode::type_tree_db::load_fixture_with_class(CLASS_TEXTURE2D)?;
        if db.get(CLASS_TEXTASSET).is_some() && db.get(CLASS_ASSETBUNDLE).is_some() {
            Some(db)
        } else {
            None
        }
    }

    fn tiny_png() -> Vec<u8> {
        use image::{ImageBuffer, Rgba};
        let img: ImageBuffer<Rgba<u8>, _> =
            ImageBuffer::from_fn(4, 4, |x, y| Rgba([(x * 64) as u8, (y * 64) as u8, 128, 255]));
        let mut buf = Vec::new();
        img.write_to(&mut std::io::Cursor::new(&mut buf), image::ImageFormat::Png)
            .unwrap();
        buf
    }

    fn load_full_glb_db() -> Option<TypeTreeDb> {
        let db = crate::encode::type_tree_db::load_fixture_with_class(CLASS_MESH)?;
        for c in [
            CLASS_GAMEOBJECT, CLASS_TRANSFORM, CLASS_MATERIAL, CLASS_MESHRENDERER,
            CLASS_MESHFILTER, CLASS_MESH, CLASS_TEXTASSET, CLASS_ASSETBUNDLE,
        ] {
            db.get(c)?;
        }
        Some(db)
    }

    #[test]
    fn assembled_glb_bundle_parses_back_with_shader_external() {
        use crate::encode::class_writers::{
            MeshAabb, MeshChannel, MeshLodRange, MeshSubMesh, UnityMaterial, UnityMeshObject,
        };
        let Some(db) = load_full_glb_db() else {
            eprintln!("skipping: no fixture with all 8 glb classes");
            return;
        };

        let aabb = MeshAabb { center: [0.0; 3], extent: [1.0; 3] };
        let mesh = UnityMeshObject {
            name: "Cube".into(),
            sub_meshes: vec![MeshSubMesh {
                index_count: 6,
                vertex_count: 4,
                local_aabb: aabb.clone(),
                ..Default::default()
            }],
            mesh_compression: 0,
            is_readable: 1,
            index_format: 1,
            index_buffer: vec![0u8; 24],
            vertex_count: 4,
            channels: vec![MeshChannel::default(); 14],
            vertex_data: vec![0u8; 128],
            local_aabb: aabb,
            cooking_options: 30,
            mesh_metrics: [1.0, 1.0],
            lod_num_levels: 1,
            lod_sub_meshes: vec![vec![MeshLodRange { index_start: 0, index_count: 0 }]],
            ..Default::default()
        };
        let material = UnityMaterial {
            name: "DCL_Scene".into(),
            lightmap_flags: 4,
            custom_render_queue: -1,
            ..Default::default()
        };
        let cab = "archive:/CAB-51fbd4c9d0fb3e603fd599ac9f5d01e1/CAB-51fbd4c9d0fb3e603fd599ac9f5d01e1";

        let bundle = assemble_glb_bundle(
            &db,
            BuildTarget::Windows,
            &db.unity_version,
            &GlbBundleInput {
                bundle_name: "abc_def_windows",
                content_filename: "abc.glb",
                game_object_name: "Cube",
                mesh: &mesh,
                material: &material,
                shader_cab_path: cab,
                shader_path_id: 0x6a1984f5061ced9d,
                dependencies: &["bafkreitexturecid".into()],
                metadata_timestamp: 0,
            },
        )
        .unwrap();

        let parsed = crate::encode::unityfs_writer::parse_bundle(&bundle).unwrap();
        let sf_node = parsed.directory.iter().find(|n| !n.path.ends_with(".resS")).unwrap();
        let sf = &parsed.data_payload_uncompressed
            [sf_node.offset as usize..(sf_node.offset + sf_node.size) as usize];

        // All 8 classes present.
        let pf = crate::encode::serialized_file_reader::parse_serialized_file(sf).unwrap();
        let class_ids: Vec<i32> = pf.types.iter().map(|t| t.class_id).collect();
        for c in [
            CLASS_GAMEOBJECT, CLASS_TRANSFORM, CLASS_MATERIAL, CLASS_MESHRENDERER,
            CLASS_MESHFILTER, CLASS_MESH, CLASS_TEXTASSET, CLASS_ASSETBUNDLE,
        ] {
            assert!(class_ids.contains(&c), "class {c} present");
        }

        // The shader external is registered and resolvable as externals[0].
        let externals = crate::encode::serialized_file_reader::parse_externals(sf).unwrap();
        assert_eq!(externals.len(), 1, "one external (the shader bundle)");
        assert_eq!(externals[0].path, cab, "shader CAB path preserved");
    }

    #[test]
    fn assembled_texture_bundle_parses_back() {
        let Some(db) = load_glb_db() else {
            eprintln!("skipping: no fixture with all 3 classes");
            return;
        };
        let png = tiny_png();
        let bundle = assemble_texture_bundle(
            &db,
            BuildTarget::Windows,
            "2022.3.12f1",
            "testhash_windows",
            "testhash.png",
            &png,
            0,
        )
        .unwrap();

        // The emitted bundle must parse back through our own reader,
        // proving structural self-consistency (UnityFS + SerializedFile
        // + object table all internally valid).
        let parsed = crate::encode::unityfs_writer::parse_bundle(&bundle).unwrap();
        let sf_node = parsed
            .directory
            .iter()
            .find(|n| !n.path.ends_with(".resS"))
            .unwrap();
        let sf = &parsed.data_payload_uncompressed
            [sf_node.offset as usize..(sf_node.offset + sf_node.size) as usize];
        let pf = crate::encode::serialized_file_reader::parse_serialized_file(sf).unwrap();

        // Three classes present.
        let class_ids: Vec<i32> = pf.types.iter().map(|t| t.class_id).collect();
        assert!(class_ids.contains(&CLASS_TEXTURE2D), "texture present");
        assert!(class_ids.contains(&CLASS_TEXTASSET), "metadata present");
        assert!(class_ids.contains(&CLASS_ASSETBUNDLE), "assetbundle present");
    }
}
