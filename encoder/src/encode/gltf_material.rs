//! glTF PBR material → DCL/Scene `UnityMaterial` conversion.
//!
//! Reverse-engineered by converting source glb materials and diffing the
//! result, byte-for-byte, against the REAL Unity Material in the matching
//! ab-cdn v49 bundle (`verify-material-from-glb`). Targets the well-formed
//! "material_N" converter behaviour (some older bundles in the corpus use a
//! default "DCL_Scene"-named variant with renderQueue=-1 / Cull=2 — a
//! distinct path, not handled here).
//!
//! Validated mapping (against the untextured opaque cube, byte-exact except
//! a 3-byte sub-ULP difference in `_BaseColor` from Unity's internal `pow`):
//!   * **name** = `material_{index}` (NOT the glТF material name).
//!   * **m_Shader** = external PPtr (file_id=1 → externals[0] shader bundle,
//!     path_id = the DCL/Scene shader's m_PathID).
//!   * **valid keywords** = the four URP forward+ shadow keywords; tag
//!     `RenderType=Opaque`; lightmapFlags=4.
//!   * **m_DoubleSidedGI** = 1 when the glTF material is `doubleSided`.
//!   * **_BaseColor** = linear→sRGB(baseColorFactor) (white if absent).
//!   * **_Metallic** = metallicFactor; **_Smoothness** = 1 − roughnessFactor.
//!   * **_Cull** = doubleSided ? 0 : 2 ; **customRenderQueue** = 2000 (opaque).
//!   * everything else = the DCL/Scene shader's default property template.
//!
//! NOT yet handled (documented extensions): texture PPtr wiring (`_BaseMap`
//! etc. point at Texture2D objects in the same bundle — an assembly-time
//! concern), and non-opaque alpha modes (BLEND/MASK change Surface/Blend/
//! SrcBlend/DstBlend/ZWrite/Cutoff/renderQueue).

use serde_json::Value as J;

use crate::encode::class_writers::{PPtr, TexEnv, UnityMaterial};

/// The DCL/Scene shader's m_PathID inside the StreamingAssets shader bundle
/// (constant across v49 bundles; see CLAUDE.md). file_id=1 → externals[0].
pub const DCL_SCENE_SHADER_PATH_ID: i64 = 0x6a1984f5061ced9d;

const OPAQUE_RENDER_QUEUE: i32 = 2000;

/// linear → sRGB (gamma) per the standard transfer function. Unity's
/// internal `pow` differs by ≤4 ULP on some inputs (sub-perceptual).
fn linear_to_srgb(x: f32) -> f32 {
    if x <= 0.0031308 {
        12.92 * x
    } else {
        1.055 * x.powf(1.0 / 2.4) - 0.055
    }
}

fn f64_field(v: &J, key: &str, default: f32) -> f32 {
    v[key].as_f64().map(|x| x as f32).unwrap_or(default)
}

/// Convert glTF `materials[index]` to a DCL/Scene `UnityMaterial`.
///
/// `tex_pptrs.base_map` etc. let the caller wire texture references once the
/// texture objects' path_ids are known (assembly time); pass `None` for the
/// untextured case.
pub fn convert_glb_material(gltf: &J, index: usize, textures: &MaterialTextures) -> UnityMaterial {
    let m = &gltf["materials"].as_array().map(|a| &a[index]).unwrap_or(&J::Null);
    let pbr = &m["pbrMetallicRoughness"];

    let base = pbr["baseColorFactor"]
        .as_array()
        .map(|a| {
            [
                a[0].as_f64().unwrap_or(1.0) as f32,
                a[1].as_f64().unwrap_or(1.0) as f32,
                a[2].as_f64().unwrap_or(1.0) as f32,
                a[3].as_f64().unwrap_or(1.0) as f32,
            ]
        })
        .unwrap_or([1.0, 1.0, 1.0, 1.0]);
    let base_color = [linear_to_srgb(base[0]), linear_to_srgb(base[1]), linear_to_srgb(base[2]), base[3]];

    let metallic = f64_field(pbr, "metallicFactor", 1.0);
    let smoothness = 1.0 - f64_field(pbr, "roughnessFactor", 1.0);
    let double_sided = m["doubleSided"].as_bool().unwrap_or(false);
    let cull = if double_sided { 0.0 } else { 2.0 };

    // Alpha mode → DCL/Scene blend state + render queue + RenderType tag.
    // Values verified against production BLEND/MASK materials via deep-diff:
    //   OPAQUE: Surface 0, Src 1, Dst 0, ZWrite 1, AlphaClip 0, Cutoff 0, q 2000
    //   BLEND : Surface 1, Src 5, Dst 10, ZWrite 0, AlphaClip 0, Cutoff 0, q 3000
    //   MASK  : Surface 1, Src 1, Dst 0, ZWrite 1, AlphaClip 1, Cutoff=cut, q 2450
    let alpha_cutoff = m["alphaCutoff"].as_f64().unwrap_or(0.5) as f32;
    let (surface, src_blend, dst_blend, zwrite, alpha_clip, cutoff, render_queue, render_type) =
        match m["alphaMode"].as_str().unwrap_or("OPAQUE") {
            "BLEND" => (1.0, 5.0, 10.0, 0.0, 0.0, 0.0, 3000, "Transparent"),
            "MASK" => (1.0, 1.0, 0.0, 1.0, 1.0, alpha_cutoff, 2450, "TransparentCutout"),
            _ => (0.0, 1.0, 0.0, 1.0, 0.0, 0.0, OPAQUE_RENDER_QUEUE, "Opaque"),
        };

    let tex = |t: &Option<PPtr>| TexEnv {
        texture: t.clone().unwrap_or_default(),
        scale: [1.0, 1.0],
        offset: [0.0, 0.0],
    };
    let tex_envs = vec![
        ("_BaseMap".into(), tex(&textures.base_map)),
        ("_BumpMap".into(), tex(&textures.bump_map)),
        ("_EmissionMap".into(), tex(&textures.emission_map)),
        ("_MainTex".into(), tex(&textures.main_tex)),
        ("_MetallicGlossMap".into(), tex(&textures.metallic_gloss_map)),
        ("_OcclusionMap".into(), tex(&textures.occlusion_map)),
        ("_ParallaxMap".into(), tex(&None)),
        ("_SpecGlossMap".into(), tex(&None)),
    ];

    let f = |n: &str, v: f32| (n.to_string(), v);
    let float_props = vec![
        f("_AlphaClip", alpha_clip), f("_AlphaToMask", 0.0), f("_Blend", 0.0), f("_BlendModePreserveSpecular", 1.0),
        f("_BlendOp", 0.0), f("_BlendOpAlpha", 0.0), f("_BumpScale", 1.0), f("_Cull", cull), f("_Cutoff", cutoff),
        f("_DstBlend", dst_blend), f("_DstBlendAlpha", 0.0), f("_EnvironmentReflections", 1.0), f("_GlossMapScale", 0.0),
        f("_Glossiness", 0.0), f("_GlossyReflections", 0.0), f("_Metallic", metallic), f("_OcclusionStrength", 1.0),
        f("_Parallax", 0.005), f("_QueueOffset", 0.0), f("_ReceiveShadows", 1.0), f("_Smoothness", smoothness),
        f("_SmoothnessTextureChannel", 0.0), f("_SpecularHighlights", 1.0), f("_SrcBlend", src_blend), f("_SrcBlendAlpha", 1.0),
        f("_Surface", surface), f("_WorkflowMode", 1.0), f("_ZWrite", zwrite),
    ];

    // Large clip sentinels (≈±2^31) and the spec-color default are exact
    // f32 constants observed in real bundles.
    let clip = 2147483600.0f32;
    let spec = 0.19999996f32;
    let color_props = vec![
        ("_BaseColor".to_string(), base_color),
        ("_Color".to_string(), [1.0, 1.0, 1.0, 1.0]),
        ("_EmissionColor".to_string(), [0.0, 0.0, 0.0, 1.0]),
        ("_PlaneClipping".to_string(), [-clip, clip, -clip, clip]),
        ("_SpecColor".to_string(), [spec, spec, spec, 1.0]),
        ("_VerticalClipping".to_string(), [-clip, clip, 0.0, 0.0]),
    ];

    UnityMaterial {
        name: format!("material_{index}"),
        shader: PPtr { file_id: 1, path_id: DCL_SCENE_SHADER_PATH_ID },
        valid_keywords: vec![
            "_ADDITIONAL_LIGHT_SHADOWS".into(),
            "_FORWARD_PLUS".into(),
            "_MAIN_LIGHT_SHADOWS_CASCADE".into(),
            "_SHADOWS_SOFT".into(),
        ],
        invalid_keywords: vec![],
        lightmap_flags: 4,
        enable_instancing_variants: 0,
        double_sided_gi: if double_sided { 1 } else { 0 },
        custom_render_queue: render_queue,
        string_tag_map: vec![("RenderType".into(), render_type.into())],
        disabled_shader_passes: vec![],
        tex_envs,
        int_props: vec![],
        float_props,
        color_props,
        build_texture_stacks: vec![],
    }
}

/// Texture PPtrs to wire into the material, filled at assembly time once the
/// in-bundle Texture2D objects' path_ids are known. All `None` = untextured.
#[derive(Debug, Default, Clone)]
pub struct MaterialTextures {
    pub base_map: Option<PPtr>,
    pub bump_map: Option<PPtr>,
    pub emission_map: Option<PPtr>,
    pub main_tex: Option<PPtr>,
    pub metallic_gloss_map: Option<PPtr>,
    pub occlusion_map: Option<PPtr>,
}
