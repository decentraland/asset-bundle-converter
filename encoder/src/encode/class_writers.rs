//! Per-class Value-graph builder scaffolds for the Unity classes the
//! glb pipeline produces.
//!
//! ⚠️ STATUS — each class is in one of three states:
//!
//!   * **Verified**: Value-graph builder matches the TypeTree exactly,
//!     end-to-end test against a real bundle passes (structural diff).
//!     Currently only Texture2D (in `texture_writer.rs`).
//!
//!   * **Field-mapped**: Value-graph builder enumerates every TypeTree
//!     child position with placeholder values. Structure is correct;
//!     values need to be filled in from real glTF input. Caught here
//!     for AssetBundle, GameObject, Transform, MeshFilter, MeshRenderer.
//!
//!   * **TODO**: Value-graph builder is stubbed; field count and types
//!     need to be derived from a fresh TypeTree dump. Mesh and Material
//!     are here because their TypeTrees are large (3822B / 8760B) and
//!     deserve their own pass.
//!
//! Iteration loop for each class:
//!   1. `cargo run --example dump_class_tree -- <class_id>` to see fields.
//!   2. Fill in the Value::Seq with the right positional values.
//!   3. `cargo run --bin verify-texture-bundle` (or analogue) for diff.
//!   4. Iterate on byte-level discrepancies.

use crate::encode::type_tree::Value;

// ===========================================================================
// TextAsset (class 49)
// ===========================================================================
//
// 2 root fields: m_Name (string) + m_Script (string). The encoder uses
// TextAsset to carry the inline `metadata.json` that the Explorer reads
// for the per-bundle dependency list.

pub fn build_text_asset_value(name: &str, script: &str) -> Value {
    Value::Seq(vec![
        Value::String(name.to_string()),
        Value::String(script.to_string()),
    ])
}

// ===========================================================================
// AssetBundle (class 142)
// ===========================================================================
//
// Every bundle Unity emits includes one AssetBundle root object that
// names the bundle's path mappings (which objects map to which asset
// paths). Without it, the Explorer's LoadAsset by-name calls return
// null. Field set (from the glb fixture's 2110-byte TypeTree):
//
//   m_Name (string)
//   m_PreloadTable (Array<PPtr<Object>>)
//   m_Container (Array<pair<string, AssetInfo>>)
//   m_MainAsset (AssetInfo)
//   m_RuntimeCompatibility (u32)
//   m_AssetBundleName (string)
//   m_Dependencies (Array<string>)
//   m_IsStreamedSceneAssetBundle (bool, ALIGN)
//   m_ExplicitDataLayout (i32)
//   m_PathFlags (i32)
//   m_SceneHashes (Array<pair<string,string>>)

#[derive(Debug, Default, Clone)]
pub struct UnityAssetBundle {
    pub name: String,
    pub preload_table: Vec<PPtr>,
    /// One container entry per object in the bundle. (key = asset path,
    /// value = AssetInfo).
    pub container: Vec<AssetBundleEntry>,
    pub main_asset: AssetInfo,
    pub runtime_compatibility: u32,
    pub asset_bundle_name: String,
    pub dependencies: Vec<String>,
    pub is_streamed_scene: bool,
    pub explicit_data_layout: i32,
    pub path_flags: i32,
    pub scene_hashes: Vec<(String, String)>,
}

#[derive(Debug, Clone)]
pub struct AssetBundleEntry {
    pub asset_path: String,
    pub preload_index: i32,
    pub preload_size: i32,
    pub asset_pptr: PPtr,
}

#[derive(Debug, Clone, Default)]
pub struct AssetInfo {
    pub preload_index: i32,
    pub preload_size: i32,
    pub asset: PPtr,
}

#[derive(Debug, Clone, Default)]
pub struct PPtr {
    pub file_id: i32,
    pub path_id: i64,
}

pub fn build_asset_bundle_value(ab: &UnityAssetBundle) -> Value {
    // 11 root children, verified positional order via
    // dump_class_tree -- 142.
    Value::Seq(vec![
        // 0: m_Name (string)
        Value::String(ab.name.clone()),
        // 1: m_PreloadTable (Array<PPtr<Object>>)
        Value::Array(ab.preload_table.iter().map(pptr_value).collect()),
        // 2: m_Container (Array<pair<string, AssetInfo>>)
        Value::Array(
            ab.container
                .iter()
                .map(|e| {
                    Value::Seq(vec![
                        Value::String(e.asset_path.clone()),
                        Value::Seq(vec![
                            Value::I32(e.preload_index),
                            Value::I32(e.preload_size),
                            pptr_value(&e.asset_pptr),
                        ]),
                    ])
                })
                .collect(),
        ),
        // 3: m_MainAsset (AssetInfo)
        Value::Seq(vec![
            Value::I32(ab.main_asset.preload_index),
            Value::I32(ab.main_asset.preload_size),
            pptr_value(&ab.main_asset.asset),
        ]),
        // 4: m_RuntimeCompatibility (u32)
        Value::U32(ab.runtime_compatibility),
        // 5: m_AssetBundleName (string)
        Value::String(ab.asset_bundle_name.clone()),
        // 6: m_Dependencies (Array<string>)
        Value::Array(ab.dependencies.iter().map(|s| Value::String(s.clone())).collect()),
        // 7: m_IsStreamedSceneAssetBundle (bool, ALIGN)
        Value::Bool(ab.is_streamed_scene),
        // 8: m_ExplicitDataLayout (i32)
        Value::I32(ab.explicit_data_layout),
        // 9: m_PathFlags (i32)
        Value::I32(ab.path_flags),
        // 10: m_SceneHashes (Array<pair<string,string>>)
        Value::Array(
            ab.scene_hashes
                .iter()
                .map(|(k, v)| Value::Seq(vec![Value::String(k.clone()), Value::String(v.clone())]))
                .collect(),
        ),
    ])
}

// ===========================================================================
// GameObject (class 1)
// ===========================================================================
//
// 571-byte TypeTree. Fields (from dump_class_tree -- 1):
//
//   m_Component (Array<ComponentPair>)
//     each ComponentPair: PPtr<Component>
//   m_Layer (u32)
//   m_Name (string)
//   m_Tag (u16)
//   m_IsActive (bool)

#[derive(Debug, Default)]
pub struct UnityGameObject {
    pub name: String,
    /// PPtrs to the components attached to this GameObject.
    /// Typically [Transform, MeshFilter, MeshRenderer] for a static mesh.
    pub components: Vec<PPtr>,
    pub layer: u32,
    pub tag: u16,
    pub is_active: bool,
}

pub fn build_game_object_value(go: &UnityGameObject) -> Value {
    // 5 root children: m_Component, m_Layer, m_Name, m_Tag, m_IsActive
    // (verified positional order via dump_class_tree -- 1).
    //
    // m_Component is Array<ComponentPair>, where ComponentPair is a
    // wrapper struct with 1 child = `component` PPtr. So each element
    // needs to be Value::Seq([pptr_value(...)]) — one level of
    // wrapping around the PPtr.
    Value::Seq(vec![
        // m_Component: Array of ComponentPair wrappers
        Value::Array(
            go.components
                .iter()
                .map(|p| Value::Seq(vec![pptr_value(p)]))
                .collect(),
        ),
        // m_Layer (u32)
        Value::U32(go.layer),
        // m_Name (string)
        Value::String(go.name.clone()),
        // m_Tag (u16)
        Value::U16(go.tag),
        // m_IsActive (bool — written as 1 byte)
        Value::Bool(go.is_active),
    ])
}

// ===========================================================================
// Transform (class 4)
// ===========================================================================
//
// 935-byte TypeTree. Fields:
//
//   m_GameObject (PPtr<GameObject>)
//   m_LocalRotation (Quaternionf — 4 floats)
//   m_LocalPosition (Vector3f — 3 floats)
//   m_LocalScale (Vector3f — 3 floats)
//   m_Children (Array<PPtr<Transform>>)
//   m_Father (PPtr<Transform>)

#[derive(Debug, Default)]
pub struct UnityTransform {
    pub game_object: PPtr,
    pub local_rotation: [f32; 4],
    pub local_position: [f32; 3],
    pub local_scale: [f32; 3],
    pub children: Vec<PPtr>,
    pub father: PPtr,
}

pub fn build_transform_value(t: &UnityTransform) -> Value {
    Value::Seq(vec![
        pptr_value(&t.game_object),
        Value::Seq(vec![
            Value::F32(t.local_rotation[0]),
            Value::F32(t.local_rotation[1]),
            Value::F32(t.local_rotation[2]),
            Value::F32(t.local_rotation[3]),
        ]),
        Value::Seq(vec![
            Value::F32(t.local_position[0]),
            Value::F32(t.local_position[1]),
            Value::F32(t.local_position[2]),
        ]),
        Value::Seq(vec![
            Value::F32(t.local_scale[0]),
            Value::F32(t.local_scale[1]),
            Value::F32(t.local_scale[2]),
        ]),
        Value::Array(t.children.iter().map(pptr_value).collect()),
        pptr_value(&t.father),
    ])
}

// ===========================================================================
// MeshFilter (class 33)
// ===========================================================================
//
// 283-byte TypeTree (smallest of the components). Fields:
//
//   m_GameObject (PPtr<GameObject>)
//   m_Mesh (PPtr<Mesh>)

#[derive(Debug, Default)]
pub struct UnityMeshFilter {
    pub game_object: PPtr,
    pub mesh: PPtr,
}

pub fn build_mesh_filter_value(mf: &UnityMeshFilter) -> Value {
    Value::Seq(vec![pptr_value(&mf.game_object), pptr_value(&mf.mesh)])
}

// ===========================================================================
// MeshRenderer (class 23)
// ===========================================================================
//
// 2347-byte TypeTree. Many fields including the Materials array, which
// is the load-bearing one for rendering. Other fields control shadow
// casting, lightmaps, ray-tracing — production glb bundles set sensible
// defaults.

/// MeshRenderer for Unity 6 (6000.2.6f2) — 32 root fields. Unity 6 added
/// 5 fields vs 2022.3 (m_RayTracingAccelStructBuildFlags{Override,},
/// m_SmallMeshCulling, m_ForceMeshLod, m_MeshLodSelectionBias). The
/// builder dispatches on byte_size so `m_Enabled` (TypeTree type name
/// "SInt16" but byte_size=1) emits as a single byte via Value::U8.
#[derive(Debug, Default, Clone)]
pub struct UnityMeshRenderer {
    pub game_object: PPtr,
    pub enabled: u8,
    pub cast_shadows: u8,
    pub receive_shadows: u8,
    pub dynamic_occludee: u8,
    pub static_shadow_caster: u8,
    pub motion_vectors: u8,
    pub light_probe_usage: u8,
    pub reflection_probe_usage: u8,
    pub ray_tracing_mode: u8,
    pub ray_trace_procedural: u8,
    // Unity 6 additions:
    pub ray_tracing_accel_struct_build_flags_override: u8,
    pub ray_tracing_accel_struct_build_flags: u8,
    pub small_mesh_culling: u8,
    pub force_mesh_lod: i16,
    pub mesh_lod_selection_bias: f32,
    // (back to fields shared with 2022.3)
    pub rendering_layer_mask: u32,
    pub renderer_priority: i32,
    pub lightmap_index: u16,
    pub lightmap_index_dynamic: u16,
    pub lightmap_tiling_offset: [f32; 4],
    pub lightmap_tiling_offset_dynamic: [f32; 4],
    pub materials: Vec<PPtr>,
    pub static_batch_first_submesh: u16,
    pub static_batch_submesh_count: u16,
    pub static_batch_root: PPtr,
    pub probe_anchor: PPtr,
    pub light_probe_volume_override: PPtr,
    pub sorting_layer_id: i32,
    pub sorting_layer: i16,
    pub sorting_order: i16,
    pub additional_vertex_streams: PPtr,
    pub enlighten_vertex_stream: PPtr,
}

pub fn build_mesh_renderer_value(m: &UnityMeshRenderer) -> Value {
    // 32 root children, verified positional order against the Unity 6
    // (6000.2.6f2) MeshRenderer TypeTree via dump-fields. Alignment is
    // applied by the walker per the TypeTree's ALIGN_BYTES flags.
    Value::Seq(vec![
        pptr_value(&m.game_object),                            // 0: m_GameObject
        Value::U8(m.enabled),                                  // 1: m_Enabled (1 byte)
        Value::U8(m.cast_shadows),                             // 2
        Value::U8(m.receive_shadows),                          // 3
        Value::U8(m.dynamic_occludee),                         // 4
        Value::U8(m.static_shadow_caster),                     // 5
        Value::U8(m.motion_vectors),                           // 6
        Value::U8(m.light_probe_usage),                        // 7
        Value::U8(m.reflection_probe_usage),                   // 8
        Value::U8(m.ray_tracing_mode),                         // 9
        Value::U8(m.ray_trace_procedural),                     // 10
        Value::U8(m.ray_tracing_accel_struct_build_flags_override), // 11 (Unity 6)
        Value::U8(m.ray_tracing_accel_struct_build_flags),     // 12 (Unity 6)
        Value::U8(m.small_mesh_culling),                       // 13 (Unity 6)
        Value::I16(m.force_mesh_lod),                          // 14 (Unity 6)
        Value::F32(m.mesh_lod_selection_bias),                 // 15 (Unity 6)
        Value::U32(m.rendering_layer_mask),                    // 16
        Value::I32(m.renderer_priority),                       // 17
        Value::U16(m.lightmap_index),                          // 18
        Value::U16(m.lightmap_index_dynamic),                  // 19
        Value::Seq(vec![
            Value::F32(m.lightmap_tiling_offset[0]),
            Value::F32(m.lightmap_tiling_offset[1]),
            Value::F32(m.lightmap_tiling_offset[2]),
            Value::F32(m.lightmap_tiling_offset[3]),
        ]),                                                    // 20: m_LightmapTilingOffset
        Value::Seq(vec![
            Value::F32(m.lightmap_tiling_offset_dynamic[0]),
            Value::F32(m.lightmap_tiling_offset_dynamic[1]),
            Value::F32(m.lightmap_tiling_offset_dynamic[2]),
            Value::F32(m.lightmap_tiling_offset_dynamic[3]),
        ]),                                                    // 21: m_LightmapTilingOffsetDynamic
        Value::Array(m.materials.iter().map(pptr_value).collect()), // 22: m_Materials
        Value::Seq(vec![
            Value::U16(m.static_batch_first_submesh),
            Value::U16(m.static_batch_submesh_count),
        ]),                                                    // 23: m_StaticBatchInfo
        pptr_value(&m.static_batch_root),                      // 24
        pptr_value(&m.probe_anchor),                           // 25
        pptr_value(&m.light_probe_volume_override),            // 26
        Value::I32(m.sorting_layer_id),                        // 27
        Value::I16(m.sorting_layer),                           // 28
        Value::I16(m.sorting_order),                           // 29
        pptr_value(&m.additional_vertex_streams),              // 30
        pptr_value(&m.enlighten_vertex_stream),                // 31
    ])
}

// ===========================================================================
// Material (class 21)
// ===========================================================================
//
// 3822-byte TypeTree. The biggest fan-out per the dump because of the
// property block (textures / floats / colors). Fields include:
//
//   m_Name (string)
//   m_Shader (PPtr<Shader> — EXTERNAL ref to bake-time shader-guids)
//   m_ValidKeywords (Array<string>)
//   m_InvalidKeywords (Array<string>)
//   m_LightmapFlags (u32)
//   m_EnableInstancingVariants (bool)
//   m_DoubleSidedGI (bool)
//   m_CustomRenderQueue (i32)
//   stringTagMap (map<string,string>)
//   disabledShaderPasses (Array<string>)
//   m_SavedProperties (struct UnityPropertySheet):
//     m_TexEnvs (map<string, TexEnv>)
//     m_Floats (map<string, float>)
//     m_Colors (map<string, ColorRGBA>)
//   m_BuildTextureStacks (Array<TextureStack>)
//
// The Shader PPtr is the tricky bit: file_id = index into the
// SerializedFile's externals table, path_id = ShaderEntry.path_id from
// the bake-time shader-guids.json. Caller must register the external
// before building this Value.

#[derive(Debug, Default)]
pub struct UnityMaterial {
    pub name: String,
    pub shader: PPtr,
    pub texture_props: Vec<(String, TexEnv)>,
    pub float_props: Vec<(String, f32)>,
    pub color_props: Vec<(String, [f32; 4])>,
}

#[derive(Debug, Clone, Default)]
pub struct TexEnv {
    pub texture: PPtr,
    pub scale: [f32; 2],
    pub offset: [f32; 2],
}

pub fn build_material_value(_m: &UnityMaterial) -> Value {
    // TODO — Material's TypeTree is the biggest at 3822 bytes; need
    // an iteration cycle with dump_class_tree -- 21 + verify against
    // a real Material object.
    Value::Seq(vec![])
}

// ===========================================================================
// Mesh (class 43)
// ===========================================================================
//
// 8760-byte TypeTree — the largest in the bundle. Vertex layout,
// vertex data, index buffer, sub-meshes, blend shapes, bind poses,
// bounds. Encoding this correctly requires:
//
//   * Vertex channel descriptor table matching how Unity packs glTF
//     attributes. The DCL converter uses a specific channel mask
//     (POSITION, NORMAL, TANGENT, COLOR, UV0..UV3, BlendIndices,
//     BlendWeight).
//   * Index buffer width (16-bit when vertex_count ≤ 65535, 32-bit
//     otherwise).
//   * Sub-mesh descriptors (one per glTF primitive).
//   * AABB computation for the whole mesh AND per sub-mesh.
//
// `encode/mesh.rs` carries the typed `UnityMesh` struct + conversion
// stubs. This builder takes that struct and produces the Value::Seq.

pub fn build_mesh_value(_m: &super::mesh::UnityMesh) -> Value {
    // TODO — biggest scope. Dump_class_tree -- 43 + iterate.
    Value::Seq(vec![])
}

// ===========================================================================
// Helpers
// ===========================================================================

/// Convert a PPtr (file_id + path_id) into the Value::Seq the
/// TypeTree-driven writer expects.
fn pptr_value(p: &PPtr) -> Value {
    Value::Seq(vec![Value::I32(p.file_id), Value::I64(p.path_id)])
}
