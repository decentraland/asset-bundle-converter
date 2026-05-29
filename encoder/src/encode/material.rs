//! Material encoding — glTF PBR → Unity Material asset binary.
//!
//! Shader resolution is name-based: the Material asset embeds an
//! external PPtr that references the shader by GUID (from the bake-time
//! shader manifest). Unity's deserializer resolves the GUID against the
//! Explorer's loaded shader registry at runtime — no shader bundle on
//! the CDN, no shader bytes in our output. (See the Explorer
//! investigation in CLAUDE.md, and the discussion at the top of
//! `lib.rs` for the resolution chain.)

use serde::Serialize;

use crate::types::{ShaderEntry, ShaderManifest, ShaderType};

/// Unity Material property block. Three families of property values map
/// directly from glTF PBR inputs to the DCL/Scene shader's property
/// names:
///
///   glTF `baseColorFactor`            → `_BaseColor` (Color)
///   glTF `baseColorTexture`           → `_BaseMap` (Texture PPtr) + tile/offset
///   glTF `metallicFactor`             → `_Metallic` (Float)
///   glTF `roughnessFactor`            → `_Smoothness` (Float, =1-roughness)
///   glTF `normalTexture`              → `_BumpMap` (Texture PPtr) + `_BumpScale`
///   glTF `emissiveFactor`             → `_EmissionColor` (Color)
///   glTF `emissiveTexture`            → `_EmissionMap` (Texture PPtr)
///   glTF `alphaMode === "MASK"`       → `_Cutoff` (Float) + AlphaTest keyword
///   glTF `alphaMode === "BLEND"`      → `_SurfaceType = 1` (Transparent) + queue
///   glTF `doubleSided`                → `_Cull = 0` (Off)
#[derive(Debug, Clone, Default, Serialize)]
pub struct MaterialProperties {
    pub colors: Vec<(String, [f32; 4])>,
    pub floats: Vec<(String, f32)>,
    pub textures: Vec<(String, TextureRef)>,
    pub keywords: Vec<String>,
    /// Render queue override; -1 means inherit from the shader.
    pub render_queue: i32,
}

#[derive(Debug, Clone, Serialize)]
pub struct TextureRef {
    /// Source content hash of the referenced texture bundle. The Unity
    /// PPtr is resolved against the dependency table in the bundle's
    /// metadata.json TextAsset.
    pub texture_hash: String,
    pub tile: [f32; 2],
    pub offset: [f32; 2],
}

#[derive(Debug, Clone, Serialize)]
pub struct UnityMaterial {
    pub name: String,
    /// External shader reference. Resolved by GUID against the
    /// Explorer's loaded shader registry at runtime.
    pub shader_ref: ShaderEntry,
    pub properties: MaterialProperties,
}

/// Pick the shader entry the encoder should bind to a given glTF
/// material under the active shader type. Returns an error if the bake
/// manifest doesn't carry the expected shader name (a misconfigured
/// bake bucket).
pub fn pick_shader<'a>(
    manifest: &'a ShaderManifest,
    shader_type: ShaderType,
) -> Result<&'a ShaderEntry, MaterialConversionError> {
    // The DCL converter's AssetBundleConverterMaterialGenerator.cs binds
    // "DCL/Scene" for ShaderType.Dcl. glTFast's path is a stand-in until
    // we decide whether to support it on the encoder path.
    let name = match shader_type {
        ShaderType::Dcl => "DCL/Scene",
        ShaderType::Gltfast => "glTFast/PbrMetallicRoughness",
    };
    manifest
        .entries
        .get(name)
        .ok_or_else(|| MaterialConversionError::ShaderNotInBake { name: name.into() })
}

/// Convert a glTF material into a UnityMaterial with the right shader
/// binding and property block. Pure CPU work.
pub fn convert_gltf_to_unity_material(
    _gltf_material_name: &str,
    _gltf_material: &GltfMaterial,
    _shader_entry: &ShaderEntry,
    _texture_hash_resolver: &dyn Fn(u32) -> Option<String>,
) -> Result<UnityMaterial, MaterialConversionError> {
    // ---------- TODO (phase 1: real material conversion) ----------------
    // For each glTF material input, emit the corresponding DCL/Scene
    // property:
    //   * baseColorFactor      → ("_BaseColor", [r,g,b,a])
    //   * baseColorTexture     → ("_BaseMap", texture_ref) + ("_BaseMap_ST", tile/offset)
    //   * metallicFactor       → ("_Metallic", f)
    //   * roughnessFactor      → ("_Smoothness", 1.0 - r)
    //   * normalTexture        → ("_BumpMap", texture_ref) + ("_BumpScale", scale)
    //   * occlusionTexture     → ("_OcclusionMap", texture_ref) + strength
    //   * emissiveFactor       → ("_EmissionColor", [r,g,b,1]) + EMISSION keyword
    //   * emissiveTexture      → ("_EmissionMap", texture_ref)
    //   * alphaMode "MASK"     → ("_Cutoff", alphaCutoff) + _ALPHATEST_ON keyword
    //   * alphaMode "BLEND"    → _SurfaceType=1, render queue 3000, _SURFACE_TYPE_TRANSPARENT
    //   * doubleSided          → _Cull=0
    //
    // Always-enabled keywords (per AssetBundleConverterMaterialGenerator.cs:9-27):
    //   _GPU_INSTANCER_BATCHER, _FORWARD_PLUS, _SHADOWS_SOFT
    //
    // Texture refs need to resolve glTF texture indices → bundle CIDs.
    // The resolver function above maps glTF texture index → image hash
    // via the contentMap walk done in `scene_encoder.rs`.
    // --------------------------------------------------------------------

    Err(MaterialConversionError::NotImplemented)
}

/// Serialise a UnityMaterial against the active TypeTree.
pub fn serialize_unity_material(
    _material: &UnityMaterial,
) -> Result<Vec<u8>, MaterialConversionError> {
    // ---------- TODO (phase 1: TypeTree-driven Material writer) ---------
    // Unity 2021.3 Material TypeTree fields (approximate order):
    //   m_Name (string)
    //   m_Shader (PPtr<Shader>)         ← write the external PPtr here
    //   m_ValidKeywords (string[])
    //   m_InvalidKeywords (string[])
    //   m_LightmapFlags (u32)
    //   m_EnableInstancingVariants (bool)
    //   m_DoubleSidedGI (bool)
    //   m_CustomRenderQueue (i32)
    //   stringTagMap (map<string,string>)
    //   disabledShaderPasses (string[])
    //   m_SavedProperties (struct UnityPropertySheet)
    //
    // The PPtr to the shader is an EXTERNAL reference: fileID indexes the
    // SerializedFile's external-refs table; the entry there carries the
    // ShaderEntry.guid + type=3, path="" (resolved by GUID at runtime).
    // pathID is the ShaderEntry.path_id.
    //
    // m_SavedProperties.m_TexEnvs is an array of (string name, TexEnv struct).
    // m_SavedProperties.m_Floats/.m_Colors are arrays of (string, float)/(string, ColorRGBA).
    // --------------------------------------------------------------------

    Err(MaterialConversionError::NotImplemented)
}

/// Minimal glTF material projection used by `convert_gltf_to_unity_material`.
/// Fields kept to what the DCL/Scene shader actually consumes.
#[derive(Debug, Clone, Default)]
pub struct GltfMaterial {
    pub base_color_factor: [f32; 4],
    pub base_color_texture: Option<u32>,
    pub metallic_factor: f32,
    pub roughness_factor: f32,
    pub normal_texture: Option<u32>,
    pub normal_scale: f32,
    pub occlusion_texture: Option<u32>,
    pub occlusion_strength: f32,
    pub emissive_factor: [f32; 3],
    pub emissive_texture: Option<u32>,
    pub alpha_mode: AlphaMode,
    pub alpha_cutoff: f32,
    pub double_sided: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum AlphaMode {
    #[default]
    Opaque,
    Mask,
    Blend,
}

#[derive(Debug, thiserror::Error)]
pub enum MaterialConversionError {
    #[error("material encoder not implemented")]
    NotImplemented,
    #[error("shader \"{name}\" not in bake manifest")]
    ShaderNotInBake { name: String },
}
