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
use crate::encode::texture_writer::{decode_to_texture2d, serialize_texture2d, serialize_texture2d_streamed, TextureStream};
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
pub const CLASS_MESHCOLLIDER: i32 = 64;
pub const CLASS_ANIMATIONCLIP: i32 = 74;
pub const CLASS_ANIMATION: i32 = 111;
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

    assemble_unityfs(db, target, unity_version, bundle_name, objects, &[], None, None)
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

    assemble_unityfs(db, target, unity_version, input.bundle_name, objects, &externals, None, None)
}

// ===========================================================================
// Full glb scene graph
// ===========================================================================

use crate::encode::class_writers::{
    build_animation_clip_value, build_animation_value, build_mesh_collider_value, UnityMeshCollider,
};
use crate::encode::gltf_mesh::{GlbScene, SceneNode, ScenePrimitive};

/// Inputs for assembling a glb's full GameObject graph.
pub struct GlbGraphInput<'a> {
    pub bundle_name: &'a str,
    /// Entity-root GameObject name (the glb hash).
    pub root_name: &'a str,
    pub content_filename: &'a str,
    pub scene: &'a GlbScene,
    /// Materials by glTF material index (shader PPtr already set by
    /// `convert_glb_material`). Visible primitives reference these.
    pub materials: &'a [UnityMaterial],
    /// glTF material index → its per-slot image indices (base / metallic-
    /// roughness / normal / emissive / occlusion).
    pub material_images: &'a [crate::encode::gltf_material::MaterialImageRefs],
    /// Image index → decoded PNG/JPG bytes (embedded glb images). Each
    /// referenced image becomes in-bundle Texture2D(s) wired into the right
    /// material channel.
    pub images: &'a std::collections::HashMap<usize, Vec<u8>>,
    pub shader_cab_path: &'a str,
    pub dependencies: &'a [String],
    pub metadata_timestamp: i64,
}

/// Identity TRS (position, rotation quaternion, scale).
const IDENTITY_TRS: ([f32; 3], [f32; 4], [f32; 3]) = ([0.0, 0.0, 0.0], [0.0, 0.0, 0.0, 1.0], [1.0, 1.0, 1.0]);

/// In-file PPtr.
fn pp(path_id: i64) -> PPtr {
    PPtr { file_id: 0, path_id }
}

/// Allocate the next path_id.
fn alloc(next: &mut i64) -> i64 {
    let v = *next;
    *next += 1;
    v
}

/// Collect (recursively) every texture-slot image referenced by VISIBLE
/// primitives' materials across the scene tree.
fn collect_used_images(
    roots: &[SceneNode],
    material_images: &[crate::encode::gltf_material::MaterialImageRefs],
    out: &mut std::collections::BTreeSet<usize>,
) {
    for node in roots {
        if !node.is_collider {
            for prim in &node.primitives {
                if let Some(refs) = material_images.get(prim.material_index) {
                    out.extend(refs.images());
                }
            }
        }
        collect_used_images(&node.children, material_images, out);
    }
}

/// Emit MeshFilter + Mesh + (MeshRenderer | MeshCollider) for `prim` on
/// GameObject `go`. Returns [MeshFilter, renderer/collider] component PPtrs.
#[allow(clippy::too_many_arguments)]
fn emit_glb_prim(
    db: &TypeTreeDb,
    next: &mut i64,
    objects: &mut Vec<PreparedObject>,
    preload: &mut Vec<PPtr>,
    material_pptr: &[i64],
    default_pptr: i64,
    go: i64,
    prim: &ScenePrimitive,
    is_collider: bool,
) -> Result<Vec<PPtr>, SerializeError> {
    let mesh_id = alloc(next);
    objects.push(PreparedObject { class_id: CLASS_MESH, path_id: mesh_id, data: serialize_class(db, CLASS_MESH, &build_mesh_value(&prim.mesh))? });
    preload.push(pp(mesh_id));
    let mf_id = alloc(next);
    objects.push(PreparedObject { class_id: CLASS_MESHFILTER, path_id: mf_id, data: serialize_class(db, CLASS_MESHFILTER, &build_mesh_filter_value(&UnityMeshFilter { game_object: pp(go), mesh: pp(mesh_id) }))? });
    let rc_id = alloc(next);
    if is_collider {
        objects.push(PreparedObject { class_id: CLASS_MESHCOLLIDER, path_id: rc_id, data: serialize_class(db, CLASS_MESHCOLLIDER, &build_mesh_collider_value(&UnityMeshCollider { game_object: pp(go), mesh: pp(mesh_id) }))? });
    } else {
        let mat_id = material_pptr.get(prim.material_index).copied().unwrap_or(default_pptr);
        let mr = UnityMeshRenderer {
            game_object: pp(go),
            enabled: 1,
            cast_shadows: 1,
            receive_shadows: 1,
            dynamic_occludee: 1,
            lightmap_index: 0xFFFF,
            lightmap_index_dynamic: 0xFFFF,
            materials: vec![pp(mat_id)],
            ..Default::default()
        };
        objects.push(PreparedObject { class_id: CLASS_MESHRENDERER, path_id: rc_id, data: serialize_class(db, CLASS_MESHRENDERER, &build_mesh_renderer_value(&mr))? });
    }
    Ok(vec![pp(mf_id), pp(rc_id)])
}

/// Emit a Transform object.
fn emit_glb_transform(
    db: &TypeTreeDb,
    objects: &mut Vec<PreparedObject>,
    tf: i64,
    go: i64,
    father: i64,
    trs: ([f32; 3], [f32; 4], [f32; 3]),
    children: &[i64],
) -> Result<(), SerializeError> {
    let t = UnityTransform {
        game_object: pp(go),
        local_rotation: trs.1,
        local_position: trs.0,
        local_scale: trs.2,
        children: children.iter().map(|&c| pp(c)).collect(),
        father: if father == 0 { PPtr::default() } else { pp(father) },
    };
    objects.push(PreparedObject { class_id: CLASS_TRANSFORM, path_id: tf, data: serialize_class(db, CLASS_TRANSFORM, &build_transform_value(&t))? });
    Ok(())
}

/// Recursively emit a scene node + its subtree, preserving parent/child
/// nesting. Returns (GameObject id, Transform id). `name_override` renames
/// the node (used to name the collapsed single scene-root after the entity
/// hash); `extra` are extra component PPtrs (e.g. the Animation component).
#[allow(clippy::too_many_arguments)]
fn emit_glb_node(
    node: &SceneNode,
    father_tf: i64,
    name_override: Option<&str>,
    extra: &[PPtr],
    db: &TypeTreeDb,
    next: &mut i64,
    objects: &mut Vec<PreparedObject>,
    preload: &mut Vec<PPtr>,
    material_pptr: &[i64],
    default_pptr: i64,
) -> Result<(i64, i64), SerializeError> {
    let go = alloc(next);
    let tf = alloc(next);
    let mut comps = vec![pp(tf)];
    if let Some(prim0) = node.primitives.first() {
        comps.extend(emit_glb_prim(db, next, objects, preload, material_pptr, default_pptr, go, prim0, node.is_collider)?);
    }
    comps.extend_from_slice(extra);
    let name = name_override.map(|s| s.to_string()).unwrap_or_else(|| node.name.clone());
    objects.push(PreparedObject { class_id: CLASS_GAMEOBJECT, path_id: go, data: serialize_class(db, CLASS_GAMEOBJECT, &build_game_object_value(&UnityGameObject { name, components: comps, layer: 0, tag: 0, is_active: true }))? });
    preload.push(pp(go));

    let mut child_tfs: Vec<i64> = Vec::new();
    // Extra primitives (1..N) → child GameObjects "{mesh}_{i}" under this node.
    for (i, prim) in node.primitives.iter().enumerate().skip(1) {
        let cgo = alloc(next);
        let ctf = alloc(next);
        let mut ccomps = vec![pp(ctf)];
        ccomps.extend(emit_glb_prim(db, next, objects, preload, material_pptr, default_pptr, cgo, prim, node.is_collider)?);
        objects.push(PreparedObject { class_id: CLASS_GAMEOBJECT, path_id: cgo, data: serialize_class(db, CLASS_GAMEOBJECT, &build_game_object_value(&UnityGameObject { name: format!("{}_{}", prim.mesh.name, i), components: ccomps, layer: 0, tag: 0, is_active: true }))? });
        preload.push(pp(cgo));
        emit_glb_transform(db, objects, ctf, cgo, tf, IDENTITY_TRS, &[])?;
        child_tfs.push(ctf);
    }
    // Child nodes (recursive).
    for child in &node.children {
        let (_, ctf) = emit_glb_node(child, tf, None, &[], db, next, objects, preload, material_pptr, default_pptr)?;
        child_tfs.push(ctf);
    }
    emit_glb_transform(db, objects, tf, go, father_tf, (node.local_position, node.local_rotation, node.local_scale), &child_tfs)?;
    Ok((go, tf))
}

/// Assemble the full glb scene: an entity-root GameObject + per-node child
/// GameObjects (prim 0 on the node GO, prims 1..N as `{mesh}_{i}` children),
/// MeshRenderer for visible meshes and MeshCollider for `_collider` nodes,
/// one Mesh per primitive, one Material per visible primitive, the DCL/Scene
/// shader external, metadata.json, and the AssetBundle root.
///
/// A single-primitive glb collapses to one GameObject (the root carries the
/// mesh components directly), matching Unity. Internally consistent + parses
/// back; uses encoder-local path-IDs (not byte-identical to Unity).
///
/// NOT handled yet: in-bundle Texture2D + material texture PPtr wiring
/// (textured materials render untextured), and non-opaque alpha modes.
pub fn assemble_glb_graph(
    db: &TypeTreeDb,
    target: BuildTarget,
    unity_version: &str,
    input: &GlbGraphInput,
) -> Result<Vec<u8>, SerializeError> {
    let mut next: i64 = 2; // 1 reserved for AssetBundle
    let mut objects: Vec<PreparedObject> = Vec::new();
    let mut preload: Vec<PPtr> = Vec::new();

    // Textures: 2× Texture2D per base-color image referenced by a VISIBLE
    // primitive (one wired into _BaseMap, one unreferenced sibling), pixels
    // STREAMED into a `.resS` sidecar. The CAB name is derived deterministically
    // from the bundle name (not the SF content hash) so the `.resS` path can
    // reference it without a circular dependency.
    let cab = cab_name_for(input.bundle_name);
    let ress_path = format!("archive:/{cab}/{cab}.resS");
    let mut ress: Vec<u8> = Vec::new();
    let mut used_images: std::collections::BTreeSet<usize> = std::collections::BTreeSet::new();
    collect_used_images(&input.scene.roots, input.material_images, &mut used_images);
    let mut img_pptr: std::collections::HashMap<usize, PPtr> = std::collections::HashMap::new();
    for img in used_images {
        let Some(png) = input.images.get(&img) else { continue };
        let Ok(tex) = decode_to_texture2d(&format!("image_{img}"), png) else { continue };
        for copy in 0..2 {
            let offset = ress.len() as u64;
            let stream = TextureStream { offset, path: &ress_path };
            let Ok(bytes) = serialize_texture2d_streamed(&tex, db, &stream) else { continue };
            ress.extend_from_slice(&tex.image_data);
            let tid = alloc(&mut next);
            objects.push(PreparedObject { class_id: CLASS_TEXTURE2D, path_id: tid, data: bytes });
            preload.push(pp(tid));
            if copy == 0 {
                img_pptr.insert(img, pp(tid));
            }
        }
    }

    // Materials: one shared Material per glb material (wired to its base-color
    // texture) + one untextured "DCL_Scene" default (matches Unity's
    // `materials = glb_materials + 1`).
    let mut material_pptr: Vec<i64> = Vec::with_capacity(input.materials.len());
    for (idx, base) in input.materials.iter().enumerate() {
        let mut material = base.clone();
        material.shader = PPtr { file_id: 1, path_id: crate::encode::gltf_material::DCL_SCENE_SHADER_PATH_ID };
        // Wire each used texture slot to its in-bundle Texture2D.
        if let Some(refs) = input.material_images.get(idx) {
            let slots = [
                ("_BaseMap", refs.base),
                ("_MetallicGlossMap", refs.metallic_rough),
                ("_BumpMap", refs.normal),
                ("_EmissionMap", refs.emissive),
                ("_OcclusionMap", refs.occlusion),
            ];
            for (chan, img) in slots {
                if let Some(p) = img.and_then(|i| img_pptr.get(&i)).cloned() {
                    for (name, te) in material.tex_envs.iter_mut() {
                        if name == chan {
                            te.texture = p.clone();
                        }
                    }
                }
            }
        }
        let mid = alloc(&mut next);
        objects.push(PreparedObject { class_id: CLASS_MATERIAL, path_id: mid, data: serialize_class(db, CLASS_MATERIAL, &build_material_value(&material))? });
        preload.push(pp(mid));
        material_pptr.push(mid);
    }
    let default_pptr = {
        // Pristine DCL/Scene shader defaults (white, metallic 0, smoothness 0.5,
        // back-cull 2) — verified against production via deep-diff.
        let mut dm = input.materials.first().cloned().unwrap_or_default();
        dm.name = "DCL_Scene".to_string();
        dm.shader = PPtr { file_id: 1, path_id: crate::encode::gltf_material::DCL_SCENE_SHADER_PATH_ID };
        for (_, te) in dm.tex_envs.iter_mut() {
            te.texture = PPtr::default();
        }
        for (k, v) in dm.float_props.iter_mut() {
            match k.as_str() {
                "_Smoothness" => *v = 0.5,
                "_Cull" => *v = 2.0,
                "_Metallic" => *v = 0.0,
                _ => {}
            }
        }
        for (k, c) in dm.color_props.iter_mut() {
            if k == "_BaseColor" {
                *c = [1.0, 1.0, 1.0, 1.0];
            }
        }
        let mid = alloc(&mut next);
        objects.push(PreparedObject { class_id: CLASS_MATERIAL, path_id: mid, data: serialize_class(db, CLASS_MATERIAL, &build_material_value(&dm))? });
        preload.push(pp(mid));
        mid
    };

    // Animations: one legacy AnimationClip per glTF animation + an Animation
    // component (emitted after the graph) on the entity-root GameObject.
    // Structural pass (empty curves; playback Explorer-gated). Skipped if the
    // fixture lacks classes 74/111.
    let mut anim_clip_pptrs: Vec<PPtr> = Vec::new();
    let mut anim_component_id: Option<i64> = None;
    if !input.scene.animation_names.is_empty() {
        if let (Some(clip_nodes), Some(_)) = (db.get(CLASS_ANIMATIONCLIP), db.get(CLASS_ANIMATION)) {
            for name in &input.scene.animation_names {
                let cid = alloc(&mut next);
                objects.push(PreparedObject { class_id: CLASS_ANIMATIONCLIP, path_id: cid, data: serialize_class(db, CLASS_ANIMATIONCLIP, &build_animation_clip_value(clip_nodes, name))? });
                preload.push(pp(cid));
                anim_clip_pptrs.push(pp(cid));
            }
            anim_component_id = Some(alloc(&mut next));
        }
    }
    let extra: Vec<PPtr> = anim_component_id.map(pp).into_iter().collect();

    // Emit the node tree. One scene root → that node IS the entity root
    // (renamed to the hash); multiple → a synthetic hash-named root wraps them.
    let root_go_id = if input.scene.roots.len() == 1 {
        emit_glb_node(
            &input.scene.roots[0], 0, Some(input.root_name), &extra,
            db, &mut next, &mut objects, &mut preload, &material_pptr, default_pptr,
        )?
        .0
    } else {
        let go = alloc(&mut next);
        let tf = alloc(&mut next);
        let mut comps = vec![pp(tf)];
        comps.extend_from_slice(&extra);
        objects.push(PreparedObject { class_id: CLASS_GAMEOBJECT, path_id: go, data: serialize_class(db, CLASS_GAMEOBJECT, &build_game_object_value(&UnityGameObject { name: input.root_name.to_string(), components: comps, layer: 0, tag: 0, is_active: true }))? });
        preload.push(pp(go));
        let mut child_tfs = Vec::new();
        for root in &input.scene.roots {
            let (_, ctf) = emit_glb_node(root, tf, None, &[], db, &mut next, &mut objects, &mut preload, &material_pptr, default_pptr)?;
            child_tfs.push(ctf);
        }
        emit_glb_transform(db, &mut objects, tf, go, 0, IDENTITY_TRS, &child_tfs)?;
        go
    };

    // Animation component (now the root GameObject id is known).
    if let Some(aid) = anim_component_id {
        let comp_nodes = db.get(CLASS_ANIMATION).expect("class 111 present (checked above)");
        objects.push(PreparedObject { class_id: CLASS_ANIMATION, path_id: aid, data: serialize_class(db, CLASS_ANIMATION, &build_animation_value(comp_nodes, &pp(root_go_id), &anim_clip_pptrs))? });
        preload.push(pp(aid));
    }

    // metadata.json TextAsset + AssetBundle root (mainAsset → entity root GO).
    let preload_count = preload.len();
    let meta_id = alloc(&mut next);
    let meta = metadata_json("7.0", input.metadata_timestamp, input.dependencies, input.content_filename);
    objects.push(PreparedObject { class_id: CLASS_TEXTASSET, path_id: meta_id, data: serialize_class(db, CLASS_TEXTASSET, &build_text_asset_value("metadata", &meta))? });
    let mut preload_table = preload.clone();
    preload_table.push(pp(meta_id));
    let ab = UnityAssetBundle {
        name: input.bundle_name.to_string(),
        preload_table,
        container: vec![
            AssetBundleEntry { asset_path: input.content_filename.to_string(), preload_index: 0, preload_size: preload_count as i32, asset_pptr: pp(root_go_id) },
            AssetBundleEntry { asset_path: "metadata.json".to_string(), preload_index: preload_count as i32, preload_size: 1, asset_pptr: pp(meta_id) },
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
    objects.push(PreparedObject { class_id: CLASS_ASSETBUNDLE, path_id: PATH_ID_ASSETBUNDLE, data: serialize_class(db, CLASS_ASSETBUNDLE, &build_asset_bundle_value(&ab))? });

    let externals = [ExternalEntry { guid: [0u8; 16], type_id: 0, path: input.shader_cab_path.to_string() }];
    let ress_opt = if ress.is_empty() { None } else { Some(ress) };
    assemble_unityfs(db, target, unity_version, input.bundle_name, objects, &externals, Some(&cab), ress_opt)
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
    cab_name: Option<&str>,
    ress: Option<Vec<u8>>,
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
    let mut nodes = match cab_name {
        Some(cab) => vec![DirectoryNode::serialized_file_named(cab.to_string(), sf_bytes)],
        None => vec![DirectoryNode::serialized_file(sf_bytes)],
    };
    if let Some(r) = ress {
        // .resS is named after the SF's CAB. cab_name is required when ress
        // is present (streamed textures need the path before SF bytes exist).
        let cab = cab_name.expect("ress requires an explicit cab_name");
        nodes.push(DirectoryNode::resource(format!("{cab}.resS"), r));
    }
    write_bundle(UnityFsWriteOptions { unity_revision: unity_version, nodes })
}

/// Deterministic 32-hex CAB name from a seed (e.g. the bundle name), so the
/// `.resS` path can reference it before the SerializedFile bytes exist.
pub fn cab_name_for(seed: &str) -> String {
    // Two FNV-1a 64 passes (plain + salted) → 128-bit, 32 hex, matching
    // Unity's CAB-name width. Value is informational; only stability matters.
    let fnv = |salt: u8| -> u64 {
        let mut h: u64 = 0xcbf29ce484222325;
        h ^= salt as u64;
        h = h.wrapping_mul(0x100000001b3);
        for &b in seed.as_bytes() {
            h ^= b as u64;
            h = h.wrapping_mul(0x100000001b3);
        }
        h
    };
    format!("CAB-{:016x}{:016x}", fnv(0), fnv(1))
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
