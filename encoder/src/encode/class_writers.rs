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

// Verified field layout (dump-fields against a real v49 DCL/Scene glb
// Material, walk EXACT 1224/1224). 12 root children:
//
//   0  m_Name (string)
//   1  m_Shader (PPtr<Shader>)            — external ref; see below
//   2  m_ValidKeywords (vector<string>)
//   3  m_InvalidKeywords (vector<string>)
//   4  m_LightmapFlags (u32)
//   5  m_EnableInstancingVariants (byte, size=1)
//   6  m_DoubleSidedGI (byte, size=1, ALIGN)
//   7  m_CustomRenderQueue (i32)
//   8  stringTagMap (map<string,string>)
//   9  disabledShaderPasses (vector<string>)
//   10 m_SavedProperties (UnityPropertySheet, 4 children):
//        m_TexEnvs (map<string, UnityTexEnv>)
//        m_Ints    (map<string, i32>)
//        m_Floats  (map<string, f32>)
//        m_Colors  (map<string, RGBAf>)
//   11 m_BuildTextureStacks (vector<>)
//
// The m_Shader PPtr is the load-bearing external: file_id indexes the
// SerializedFile externals table (the `archive:/CAB-<shaderbundle>/…`
// entry the assembler registers), path_id is the shader's m_PathID
// inside that StreamingAssets shader bundle. Verified real value:
// file_id=1, path_id=0x6a1984f5061ced9d.
#[derive(Debug, Default, Clone)]
pub struct UnityMaterial {
    pub name: String,
    pub shader: PPtr,
    pub valid_keywords: Vec<String>,
    pub invalid_keywords: Vec<String>,
    pub lightmap_flags: u32,
    pub enable_instancing_variants: u8,
    pub double_sided_gi: u8,
    pub custom_render_queue: i32,
    pub string_tag_map: Vec<(String, String)>,
    pub disabled_shader_passes: Vec<String>,
    pub tex_envs: Vec<(String, TexEnv)>,
    pub int_props: Vec<(String, i32)>,
    pub float_props: Vec<(String, f32)>,
    pub color_props: Vec<(String, [f32; 4])>,
    /// Always empty in DCL bundles; element type is irrelevant while empty.
    pub build_texture_stacks: Vec<String>,
}

#[derive(Debug, Clone, Default)]
pub struct TexEnv {
    pub texture: PPtr,
    pub scale: [f32; 2],
    pub offset: [f32; 2],
}

pub fn build_material_value(m: &UnityMaterial) -> Value {
    Value::Seq(vec![
        // 0: m_Name
        Value::String(m.name.clone()),
        // 1: m_Shader (PPtr<Shader>)
        pptr_value(&m.shader),
        // 2: m_ValidKeywords (vector<string>)
        Value::Array(m.valid_keywords.iter().map(|s| Value::String(s.clone())).collect()),
        // 3: m_InvalidKeywords (vector<string>)
        Value::Array(m.invalid_keywords.iter().map(|s| Value::String(s.clone())).collect()),
        // 4: m_LightmapFlags
        Value::U32(m.lightmap_flags),
        // 5: m_EnableInstancingVariants (1 byte)
        Value::U8(m.enable_instancing_variants),
        // 6: m_DoubleSidedGI (1 byte, ALIGN handled by the writer)
        Value::U8(m.double_sided_gi),
        // 7: m_CustomRenderQueue
        Value::I32(m.custom_render_queue),
        // 8: stringTagMap (map<string,string>)
        Value::Array(
            m.string_tag_map
                .iter()
                .map(|(k, v)| Value::Seq(vec![Value::String(k.clone()), Value::String(v.clone())]))
                .collect(),
        ),
        // 9: disabledShaderPasses (vector<string>)
        Value::Array(m.disabled_shader_passes.iter().map(|s| Value::String(s.clone())).collect()),
        // 10: m_SavedProperties (UnityPropertySheet)
        Value::Seq(vec![
            // m_TexEnvs (map<string, UnityTexEnv>)
            Value::Array(
                m.tex_envs
                    .iter()
                    .map(|(name, te)| Value::Seq(vec![Value::String(name.clone()), tex_env_value(te)]))
                    .collect(),
            ),
            // m_Ints (map<string, i32>)
            Value::Array(
                m.int_props
                    .iter()
                    .map(|(k, v)| Value::Seq(vec![Value::String(k.clone()), Value::I32(*v)]))
                    .collect(),
            ),
            // m_Floats (map<string, f32>)
            Value::Array(
                m.float_props
                    .iter()
                    .map(|(k, v)| Value::Seq(vec![Value::String(k.clone()), Value::F32(*v)]))
                    .collect(),
            ),
            // m_Colors (map<string, RGBAf>)
            Value::Array(
                m.color_props
                    .iter()
                    .map(|(k, c)| {
                        Value::Seq(vec![
                            Value::String(k.clone()),
                            Value::Seq(vec![Value::F32(c[0]), Value::F32(c[1]), Value::F32(c[2]), Value::F32(c[3])]),
                        ])
                    })
                    .collect(),
            ),
        ]),
        // 11: m_BuildTextureStacks (vector<>)
        Value::Array(m.build_texture_stacks.iter().map(|s| Value::String(s.clone())).collect()),
    ])
}

/// UnityTexEnv: m_Texture (PPtr) + m_Scale (Vector2f) + m_Offset (Vector2f).
fn tex_env_value(te: &TexEnv) -> Value {
    Value::Seq(vec![
        pptr_value(&te.texture),
        Value::Seq(vec![Value::F32(te.scale[0]), Value::F32(te.scale[1])]),
        Value::Seq(vec![Value::F32(te.offset[0]), Value::F32(te.offset[1])]),
    ])
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

// Serialized-form Mesh (the byte-exact view, distinct from the
// geometry-oriented `mesh::UnityMesh` used by the glTF converter). Field
// layout verified by dump-fields against a real v49 (Unity 6000.2.6f2)
// glb Mesh — walk EXACT. 25 root fields; the always-empty sub-structures
// for a static DCL mesh (blend shapes, bind pose, bone data, compressed
// mesh) are hardcoded in the builder, so this struct carries only the
// fields that actually vary.
#[derive(Debug, Default, Clone)]
pub struct MeshAabb {
    pub center: [f32; 3],
    pub extent: [f32; 3],
}

#[derive(Debug, Default, Clone)]
pub struct MeshSubMesh {
    pub first_byte: u32,
    pub index_count: u32,
    pub topology: i32,
    pub base_vertex: u32,
    pub first_vertex: u32,
    pub vertex_count: u32,
    pub local_aabb: MeshAabb,
}

#[derive(Debug, Default, Clone, Copy)]
pub struct MeshChannel {
    pub stream: u8,
    pub offset: u8,
    pub format: u8,
    pub dimension: u8,
}

#[derive(Debug, Default, Clone)]
pub struct MeshLodRange {
    pub index_start: u32,
    pub index_count: u32,
}

#[derive(Debug, Default, Clone)]
pub struct UnityMeshObject {
    pub name: String,
    pub sub_meshes: Vec<MeshSubMesh>,
    pub root_bone_name_hash: u32,
    pub mesh_compression: u8,
    pub is_readable: u8,
    pub keep_vertices: u8,
    pub keep_indices: u8,
    pub index_format: i32,
    /// Raw index buffer bytes (16- or 32-bit indices per index_format).
    pub index_buffer: Vec<u8>,
    pub vertex_count: u32,
    /// 14 channel slots (Unity emits all 14; unused slots are zeroed).
    pub channels: Vec<MeshChannel>,
    /// Interleaved vertex stream bytes.
    pub vertex_data: Vec<u8>,
    pub local_aabb: MeshAabb,
    pub mesh_usage_flags: i32,
    pub cooking_options: i32,
    pub mesh_metrics: [f32; 2],
    pub stream_offset: u64,
    pub stream_size: u32,
    pub stream_path: String,
    // m_MeshLodInfo (Unity 6):
    pub lod_slope: f32,
    pub lod_bias: f32,
    pub lod_num_levels: i32,
    /// One Vec<MeshLodRange> per MeshLodSubMesh (its m_Levels array).
    pub lod_sub_meshes: Vec<Vec<MeshLodRange>>,
}

fn mesh_aabb_value(a: &MeshAabb) -> Value {
    Value::Seq(vec![
        Value::Seq(vec![Value::F32(a.center[0]), Value::F32(a.center[1]), Value::F32(a.center[2])]),
        Value::Seq(vec![Value::F32(a.extent[0]), Value::F32(a.extent[1]), Value::F32(a.extent[2])]),
    ])
}

/// Empty 5-child PackedBitVector: m_NumItems, m_Range, m_Start, m_Data, m_BitSize.
fn empty_pbv5() -> Value {
    Value::Seq(vec![
        Value::U32(0),
        Value::F32(0.0),
        Value::F32(0.0),
        Value::Bytes(vec![]),
        Value::U8(0),
    ])
}

/// Empty 3-child PackedBitVector: m_NumItems, m_Data, m_BitSize.
fn empty_pbv3() -> Value {
    Value::Seq(vec![Value::U32(0), Value::Bytes(vec![]), Value::U8(0)])
}

pub fn build_mesh_value(m: &UnityMeshObject) -> Value {
    Value::Seq(vec![
        // 0: m_Name
        Value::String(m.name.clone()),
        // 1: m_SubMeshes (Array<SubMesh>)
        Value::Array(
            m.sub_meshes
                .iter()
                .map(|s| {
                    Value::Seq(vec![
                        Value::U32(s.first_byte),
                        Value::U32(s.index_count),
                        Value::I32(s.topology),
                        Value::U32(s.base_vertex),
                        Value::U32(s.first_vertex),
                        Value::U32(s.vertex_count),
                        mesh_aabb_value(&s.local_aabb),
                    ])
                })
                .collect(),
        ),
        // 2: m_Shapes (BlendShapeData: vertices, shapes, channels, fullWeights — all empty)
        Value::Seq(vec![
            Value::Array(vec![]),
            Value::Array(vec![]),
            Value::Array(vec![]),
            Value::Array(vec![]),
        ]),
        // 3: m_BindPose (Array<Matrix4x4f>, empty)
        Value::Array(vec![]),
        // 4: m_BoneNameHashes (Array<u32>, empty)
        Value::Array(vec![]),
        // 5: m_RootBoneNameHash (u32)
        Value::U32(m.root_bone_name_hash),
        // 6: m_BonesAABB (Array, empty)
        Value::Array(vec![]),
        // 7: m_VariableBoneCountWeights (struct{ m_Data: Array<u32> empty })
        Value::Seq(vec![Value::Array(vec![])]),
        // 8-11: m_MeshCompression / m_IsReadable / m_KeepVertices / m_KeepIndices (bytes)
        Value::U8(m.mesh_compression),
        Value::U8(m.is_readable),
        Value::U8(m.keep_vertices),
        Value::U8(m.keep_indices),
        // 12: m_IndexFormat (i32)
        Value::I32(m.index_format),
        // 13: m_IndexBuffer (TypelessData<u8>, ALIGN)
        Value::Bytes(m.index_buffer.clone()),
        // 14: m_VertexData (struct: m_VertexCount, m_Channels, m_DataSize)
        Value::Seq(vec![
            Value::U32(m.vertex_count),
            Value::Array(
                m.channels
                    .iter()
                    .map(|c| {
                        Value::Seq(vec![
                            Value::U8(c.stream),
                            Value::U8(c.offset),
                            Value::U8(c.format),
                            Value::U8(c.dimension),
                        ])
                    })
                    .collect(),
            ),
            Value::Bytes(m.vertex_data.clone()),
        ]),
        // 15: m_CompressedMesh (10 PackedBitVectors + m_UVInfo) — all empty
        Value::Seq(vec![
            empty_pbv5(), // m_Vertices
            empty_pbv5(), // m_UV
            empty_pbv5(), // m_Normals
            empty_pbv5(), // m_Tangents
            empty_pbv3(), // m_Weights
            empty_pbv3(), // m_NormalSigns
            empty_pbv3(), // m_TangentSigns
            empty_pbv5(), // m_FloatColors
            empty_pbv3(), // m_BoneIndices
            empty_pbv3(), // m_Triangles
            Value::U32(0), // m_UVInfo
        ]),
        // 16: m_LocalAABB
        mesh_aabb_value(&m.local_aabb),
        // 17: m_MeshUsageFlags (i32)
        Value::I32(m.mesh_usage_flags),
        // 18: m_CookingOptions (i32)
        Value::I32(m.cooking_options),
        // 19: m_BakedConvexCollisionMesh (TypelessData, empty)
        Value::Bytes(vec![]),
        // 20: m_BakedTriangleCollisionMesh (TypelessData, empty)
        Value::Bytes(vec![]),
        // 21-22: m_MeshMetrics[0..1] (f32)
        Value::F32(m.mesh_metrics[0]),
        Value::F32(m.mesh_metrics[1]),
        // 23: m_StreamData (StreamingInfo: offset u64, size u32, path string)
        Value::Seq(vec![
            Value::U64(m.stream_offset),
            Value::U32(m.stream_size),
            Value::String(m.stream_path.clone()),
        ]),
        // 24: m_MeshLodInfo (LodSelectionCurve, m_NumLevels, m_SubMeshes)
        Value::Seq(vec![
            // m_LodSelectionCurve: m_LodSlope, m_LodBias
            Value::Seq(vec![Value::F32(m.lod_slope), Value::F32(m.lod_bias)]),
            // m_NumLevels
            Value::I32(m.lod_num_levels),
            // m_SubMeshes (Array<MeshLodSubMesh{ m_Levels: Array<MeshLodRange> }>)
            Value::Array(
                m.lod_sub_meshes
                    .iter()
                    .map(|levels| {
                        Value::Seq(vec![Value::Array(
                            levels
                                .iter()
                                .map(|r| Value::Seq(vec![Value::U32(r.index_start), Value::U32(r.index_count)]))
                                .collect(),
                        )])
                    })
                    .collect(),
            ),
        ]),
    ])
}

// ===========================================================================
// Helpers
// ===========================================================================

/// Convert a PPtr (file_id + path_id) into the Value::Seq the
/// TypeTree-driven writer expects.
fn pptr_value(p: &PPtr) -> Value {
    Value::Seq(vec![Value::I32(p.file_id), Value::I64(p.path_id)])
}
