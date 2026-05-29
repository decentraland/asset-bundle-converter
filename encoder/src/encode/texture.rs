//! Texture encoding — PNG/JPG bytes → Unity Texture2D asset binary.
//!
//! Each Unity build target wants different compressed texture formats:
//!   * Windows (StandaloneWindows64) → BC7 RGBA (high-quality DXT)
//!   * Mac (StandaloneOSX)           → ASTC 6x6 RGBA on Apple Silicon,
//!                                      BC7 on Intel; we pick ASTC because
//!                                      the Explorer's `AlwaysIncludedShaders`
//!                                      ships variants for it.
//!   * WebGL                         → ETC2 RGB / RGBA (universal on
//!                                      WebGL 2.0)
//!
//! All three encoders are pure CPU; suitable Rust crates exist for each
//! (`intel_tex_2` / `bc7e` for BC7, `astcenc-rs` for ASTC,
//! `ispc_texcomp` or `etc2comp-rs` for ETC2). Choice deferred to phase 1.

use serde::Serialize;

use crate::types::BuildTarget;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum UnityTextureFormat {
    /// 32-bit RGBA, no compression. Used when a texture's source format
    /// is too small to benefit from block compression (≤ 32×32).
    RGBA32,
    /// BC7 — Windows + Mac/Intel.
    BC7,
    /// ASTC 6x6 RGBA — Mac/Apple Silicon.
    ASTC_6x6,
    /// ETC2 RGB — WebGL opaque.
    ETC2_RGB,
    /// ETC2 RGBA — WebGL with alpha.
    ETC2_RGBA,
}

impl UnityTextureFormat {
    /// Unity's internal `TextureFormat` enum value — the integer the
    /// TypeTree writer emits for `m_TextureFormat`. Values from
    /// `UnityEngine/TextureFormat.cs` in the Unity reference repo.
    pub fn unity_enum_value(self) -> i32 {
        match self {
            UnityTextureFormat::RGBA32 => 4,
            UnityTextureFormat::BC7 => 25,
            UnityTextureFormat::ASTC_6x6 => 50, // ASTC_RGBA_6x6
            UnityTextureFormat::ETC2_RGB => 45,
            UnityTextureFormat::ETC2_RGBA => 47,
        }
    }
}

/// Pick the default compressed format the encoder targets for a given
/// build target + alpha mode. Mirrors Unity's TextureImporter behaviour
/// when `textureCompression = CompressedHQ`.
pub fn default_format(target: BuildTarget, has_alpha: bool) -> UnityTextureFormat {
    match (target, has_alpha) {
        (BuildTarget::Windows, _) => UnityTextureFormat::BC7,
        // For phase 1 we ship BC7 on Mac as well (matches Intel Macs);
        // ASTC variant for Apple Silicon is a phase 2 toggle that needs
        // a runtime check on the Explorer side or two bundles per
        // texture (which we won't ship).
        (BuildTarget::Mac, _) => UnityTextureFormat::BC7,
        (BuildTarget::Webgl, false) => UnityTextureFormat::ETC2_RGB,
        (BuildTarget::Webgl, true) => UnityTextureFormat::ETC2_RGBA,
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct UnityTexture2D {
    pub name: String,
    pub width: u32,
    pub height: u32,
    pub mip_count: u32,
    pub format: UnityTextureFormat,
    /// Compressed payload, mip0 first, then each successive mip level
    /// concatenated. Empty `image_data` is allowed when the texture
    /// lives in `m_StreamData` (off-bundle); we never do that — every
    /// texture is fully inline.
    pub image_data: Vec<u8>,
    pub filter_mode: FilterMode,
    pub wrap_mode: WrapMode,
    pub aniso_level: i32,
}

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum FilterMode {
    Point,
    Bilinear,
    Trilinear,
}

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum WrapMode {
    Repeat,
    Clamp,
    Mirror,
    MirrorOnce,
}

/// Decode a PNG/JPG byte buffer into raw RGBA8, returning the decoded
/// dimensions and the pixel buffer (rows top-to-bottom, RGBA per pixel).
pub fn decode_source(_bytes: &[u8]) -> Result<DecodedImage, TextureError> {
    // ---------- TODO (phase 1: real decoder) ----------------------------
    // Use the `image` crate (already widely used in Rust ecosystem):
    //   let img = image::load_from_memory(bytes)?;
    //   let rgba = img.to_rgba8();
    //   return Ok(DecodedImage { width: rgba.width(), height: rgba.height(), rgba: rgba.into_raw() });
    //
    // Watch out for:
    //   * Non-power-of-2 textures — Unity tolerates them, but mip
    //     generation degrades. We can pad to NPOT or just skip mips.
    //   * JPEG without alpha — must produce 0xff alpha in RGBA output.
    //   * Large textures — guard against decompressing a 16k×16k PNG
    //     to 1 GiB of RGBA bytes; cap source dimensions at e.g. 4096².
    // --------------------------------------------------------------------
    Err(TextureError::NotImplemented)
}

pub struct DecodedImage {
    pub width: u32,
    pub height: u32,
    /// Tightly packed RGBA8, rows top-to-bottom.
    pub rgba: Vec<u8>,
}

/// Compress decoded RGBA8 into the target Unity texture format.
pub fn compress_to_format(
    _decoded: &DecodedImage,
    _format: UnityTextureFormat,
    _generate_mips: bool,
) -> Result<Vec<u8>, TextureError> {
    // ---------- TODO (phase 1: real encoders) ---------------------------
    // BC7  : use the `intel_tex_2` crate (BC7 fast / BC7 slow modes).
    //         Output stride: 16 bytes per 4×4 block.
    // ASTC : use `astc-encoder-rs` or shell out to a vendored astcenc lib.
    //         Output stride: 16 bytes per N×N block (we use 6×6).
    // ETC2 : use `etc2comp` Rust binding, or `ispc_texcomp`.
    //         Output stride: 8 bytes per 4×4 block (RGB) / 16 (RGBA).
    //
    // For mip generation: simple 2x2 box filter is sufficient for phase 1.
    // Use `image::imageops::resize` with `FilterType::Triangle` for
    // higher quality on photographic textures.
    //
    // Output layout: mip0 bytes, then mip1, mip2, ..., concatenated.
    // Unity reads them by computing each mip's expected size from
    // (mipWidth, mipHeight, format-block-size).
    // --------------------------------------------------------------------
    Err(TextureError::NotImplemented)
}

/// Serialise a UnityTexture2D against the active TypeTree.
pub fn serialize_unity_texture2d(_tex: &UnityTexture2D) -> Result<Vec<u8>, TextureError> {
    // ---------- TODO (phase 1: TypeTree-driven Texture2D writer) --------
    // Unity 2021.3 Texture2D TypeTree (approximate, from TypeTreeGenerator):
    //   m_Name (string)
    //   m_ForcedFallbackFormat (i32)
    //   m_DownscaleFallback (bool)
    //   m_IsAlphaChannelOptional (bool)
    //   m_Width (i32)
    //   m_Height (i32)
    //   m_CompleteImageSize (i32)            ← total bytes in image_data
    //   m_MipsStripped (i32)
    //   m_TextureFormat (i32)                ← UnityTextureFormat::unity_enum_value()
    //   m_MipCount (i32)
    //   m_IsReadable (bool)
    //   m_IsPreProcessed (bool)
    //   m_IgnoreMipmapLimit (bool)
    //   m_MipmapLimitGroupName (string)
    //   m_StreamingMipmaps (bool)
    //   m_StreamingMipmapsPriority (i32)
    //   m_ImageCount (i32)
    //   m_TextureDimension (i32 = 2)
    //   m_TextureSettings (struct GLTextureSettings)
    //   m_LightmapFormat (i32)
    //   m_ColorSpace (i32)                    ← 0 = Linear, 1 = sRGB
    //   m_PlatformBlob (array<u8>)
    //   image data (array<u8>, length = m_CompleteImageSize)
    //   m_StreamData (struct {offset:i64, size:u32, path:string})
    //
    // Each align-flagged field needs the 4-byte pad after write.
    // --------------------------------------------------------------------
    Err(TextureError::NotImplemented)
}

#[derive(Debug, thiserror::Error)]
pub enum TextureError {
    #[error("texture encoder not implemented")]
    NotImplemented,
    #[error("source decode failed: {0}")]
    SourceDecode(String),
    #[error("unsupported source format: {0}")]
    UnsupportedSource(String),
}
