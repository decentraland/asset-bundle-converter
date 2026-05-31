//! End-to-end Texture2D writer.
//!
//! Pipeline:
//!   PNG/JPG bytes  →  decode (image crate)  →  UnityTexture2D struct
//!   →  Value::Seq (positional, matching TypeTree child order)
//!   →  TypeTreeWriter → serialized object bytes
//!   →  packaged into a SerializedFile + UnityFS bundle by the caller
//!
//! ⚠️ STATUS — produces structurally-correct bytes per the TypeTree
//! schema we extracted, BUT not byte-diff-verified against a real Unity
//! texture bundle yet. The Texture2D class has subtle traps:
//!   * `image data` field has type "TypelessData" wrapped in an
//!     Array container — Unity writes (size, data[size]) just like a
//!     dynamic array, NOT a length-prefixed-string.
//!   * `m_StreamData` carries offset/size/path; when the texture is
//!     fully inline (our case), offset=0, size=0, path="".
//!   * Production bundles set `m_TextureSettings` with non-zero defaults
//!     (filterMode=1 / Bilinear, wrapU=0 / Repeat, etc).
//!
//! The verification harness at `src/bin/verify-texture.rs` runs this
//! writer against a real reference bundle and diffs byte-by-byte —
//! that's the iteration loop for fixing remaining discrepancies.


use crate::encode::type_tree::{TypeTreeWriter, Value};
use crate::encode::type_tree_db::TypeTreeDb;
use crate::encode::SerializeError;

/// In-memory Texture2D ready to serialize.
#[derive(Debug, Clone)]
pub struct UnityTexture2D {
    pub name: String,
    pub width: u32,
    pub height: u32,
    /// Unity TextureFormat enum value. 4 = RGBA32 (uncompressed, 32-bit
    /// RGBA, 4 bytes/pixel). Higher-quality formats (BC7=25, ASTC_6x6=50,
    /// ETC2_RGBA=47) need their own encoder crates which we haven't
    /// vendored yet.
    pub texture_format: i32,
    /// Mipmap chain count. 1 = no mips (mip0 only). Texture2D allows
    /// 1..32 but writer never generates mips automatically — caller
    /// passes already-mipchained image_data.
    pub mip_count: i32,
    /// 0 = Linear, 1 = sRGB. Always sRGB for color textures.
    pub color_space: i32,
    /// Raw image bytes, concatenated mip0..mipN.
    pub image_data: Vec<u8>,
}

/// The standard "RGBA32" TextureFormat value Unity uses (no
/// compression, 4 bytes/pixel).
pub const TEXTURE_FORMAT_RGBA32: i32 = 4;

/// "BC7" TextureFormat — GPU-compressed, 1 byte/texel. What production DCL
/// texture bundles use.
pub const TEXTURE_FORMAT_BC7: i32 = 25;

/// `TextureDimension::Tex2D` per UnityEngine.Rendering.TextureDimension.
pub const TEXTURE_DIMENSION_2D: i32 = 2;

/// Decode PNG / JPEG bytes into a UnityTexture2D in **BC7** format with a
/// full mip chain — matching production (`m_TextureFormat=25`, `m_MipCount`
/// = full chain, `m_CompleteImageSize` = BC7+mips byte total). The BC7 is a
/// pure-Rust mode-6 encode (see `encode::bc7`); lower quality than an ISPC
/// encoder but a valid, decodable BC7 stream with byte sizes identical to
/// Unity's. color_space = sRGB.
pub fn decode_to_texture2d(name: &str, bytes: &[u8]) -> Result<UnityTexture2D, SerializeError> {
    let img = image::load_from_memory(bytes)
        .map_err(|e| SerializeError::Format(format!("image decode failed: {e}")))?;
    let rgba0 = img.to_rgba8();
    // BC7 (compressed) copy: downscale so max dim ≤ 1024, each axis to nearest
    // power-of-two, then BC7 + full mips. Matches production's compressed
    // variant (8192×4096→1024×512, 640²→512², etc).
    let (fw, fh) = fit(rgba0.width(), rgba0.height(), MAX_BC7_DIM);
    let (w, h) = (nearest_pow2(fw).max(4), nearest_pow2(fh).max(4));
    let rgba = if (w, h) != (rgba0.width(), rgba0.height()) {
        image::imageops::resize(&rgba0, w, h, image::imageops::FilterType::Triangle)
    } else {
        rgba0
    };
    let (bc7, mip_count) = crate::encode::bc7::compress_with_mips(rgba.as_raw(), w, h);
    Ok(UnityTexture2D {
        name: name.to_string(),
        width: w,
        height: h,
        texture_format: TEXTURE_FORMAT_BC7,
        mip_count,
        color_space: 1, // sRGB
        image_data: bc7,
    })
}

/// ARGB32 TextureFormat (byte order A,R,G,B) — production's full-resolution,
/// single-mip companion to the BC7 copy.
pub const TEXTURE_FORMAT_ARGB32: i32 = 5;

/// Largest dimension kept for the ARGB32 full-res copy. Production keeps the
/// true source size (e.g. 8192×4096 = 134 MiB); we cap to keep bundles sane —
/// a deviation only on textures larger than this (rare).
const MAX_ARGB_DIM: u32 = 2048;
/// Compressed-copy dimension cap (production downscales BC7 to ≤1024).
const MAX_BC7_DIM: u32 = 1024;

/// Nearest power-of-two to `n` (linear distance; ties → lower).
fn nearest_pow2(n: u32) -> u32 {
    if n <= 1 {
        return 1;
    }
    let lo = 1u32 << (31 - n.leading_zeros());
    let hi = lo << 1;
    if n - lo <= hi - n {
        lo
    } else {
        hi
    }
}

/// Uniformly scale (w,h) so the larger axis ≤ `max_dim`; smaller stays as-is.
fn fit(w: u32, h: u32, max_dim: u32) -> (u32, u32) {
    let m = w.max(h);
    if m <= max_dim {
        (w, h)
    } else {
        let s = max_dim as f32 / m as f32;
        (((w as f32 * s).round() as u32).max(1), ((h as f32 * s).round() as u32).max(1))
    }
}

/// Decode into the ARGB32 (fmt 5), full-resolution, single-mip copy that
/// production emits alongside the BC7 one. Pixels stored A,R,G,B.
pub fn decode_to_texture2d_argb32(name: &str, bytes: &[u8]) -> Result<UnityTexture2D, SerializeError> {
    let img = image::load_from_memory(bytes)
        .map_err(|e| SerializeError::Format(format!("image decode failed: {e}")))?;
    let mut rgba = img.to_rgba8();
    let (w0, h0) = (rgba.width(), rgba.height());
    let (w, h) = fit(w0, h0, MAX_ARGB_DIM);
    if (w, h) != (w0, h0) {
        rgba = image::imageops::resize(&rgba, w, h, image::imageops::FilterType::Triangle);
    }
    let mut data = Vec::with_capacity((w * h * 4) as usize);
    for px in rgba.pixels() {
        let [r, g, b, a] = px.0;
        data.extend_from_slice(&[a, r, g, b]);
    }
    Ok(UnityTexture2D {
        name: name.to_string(),
        width: w,
        height: h,
        texture_format: TEXTURE_FORMAT_ARGB32,
        mip_count: 1,
        color_space: 1, // sRGB
        image_data: data,
    })
}

/// Serialize a UnityTexture2D into the bytes that go into a
/// SerializedFile's object data section. Walks the Texture2D
/// TypeTree from the loaded fixture, emits a Value::Seq matching the
/// observed child order.
///
/// Field order — **Unity 6 (6000.2.x)**, the production target, verified
/// against a real v49 Texture2D (22 root children). Unity 6 dropped the
/// `m_ForcedFallbackFormat` + `m_DownscaleFallback` fields that Unity
/// 2022.3 had (which is why a 2022.3-shaped 24-field Seq is rejected by
/// the Unity-6 TypeTree). Fields:
///   0:  m_Name (string)
///   1:  m_IsAlphaChannelOptional (bool, ALIGN)
///   2:  m_Width (i32)
///   3:  m_Height (i32)
///   4:  m_CompleteImageSize (u32)
///   5:  m_MipsStripped (i32)
///   6:  m_TextureFormat (i32)
///   7:  m_MipCount (i32)
///   8:  m_IsReadable (bool)
///   9:  m_IsPreProcessed (bool)
///   10: m_IgnoreMipmapLimit (bool, ALIGN)
///   11: m_MipmapLimitGroupName (string)
///   12: m_StreamingMipmaps (bool, ALIGN)
///   13: m_StreamingMipmapsPriority (i32)
///   14: m_ImageCount (i32)
///   15: m_TextureDimension (i32)
///   16: m_TextureSettings (struct with 6 children)
///   17: m_LightmapFormat (i32)
///   18: m_ColorSpace (i32)
///   19: m_PlatformBlob (TypelessData, empty)
///   20: image data (TypelessData = u8 array)
///   21: m_StreamData (struct with offset/size/path)
///
/// The Seq length is asserted against the fixture's actual root child
/// count up front, so a future Unity-version field change fails loudly
/// here (with a clear message) rather than producing a malformed object.
pub fn serialize_texture2d(
    tex: &UnityTexture2D,
    db: &TypeTreeDb,
) -> Result<Vec<u8>, SerializeError> {
    serialize_texture2d_impl(tex, db, None)
}

/// A streamed reference to texture pixels living in a `.resS` sidecar.
pub struct TextureStream<'a> {
    /// Byte offset of this texture's pixels within the `.resS`.
    pub offset: u64,
    /// `archive:/CAB-<x>/CAB-<x>.resS` — the m_StreamData path.
    pub path: &'a str,
}

/// Streamed variant: the pixel bytes are NOT inline — `image data` is empty
/// and `m_StreamData` points at the `.resS` sidecar. Matches the structure
/// real Unity texture bundles use (tiny Texture2D object + streamed pixels).
/// The caller is responsible for placing `tex.image_data` into the `.resS`
/// payload at `stream.offset`.
pub fn serialize_texture2d_streamed(
    tex: &UnityTexture2D,
    db: &TypeTreeDb,
    stream: &TextureStream<'_>,
) -> Result<Vec<u8>, SerializeError> {
    serialize_texture2d_impl(tex, db, Some(stream))
}

fn serialize_texture2d_impl(
    tex: &UnityTexture2D,
    db: &TypeTreeDb,
    stream: Option<&TextureStream<'_>>,
) -> Result<Vec<u8>, SerializeError> {
    let nodes = db
        .get(28)
        .ok_or_else(|| SerializeError::Format("Texture2D (class 28) missing from fixture".into()))?;

    // Streamed: image data array empty, pixels described by m_StreamData.
    // Inline: image data carries the bytes, m_StreamData is empty.
    let (image_field, stream_field) = match stream {
        Some(s) => (
            typeless_data(&[]),
            streaming_info(s.offset, tex.image_data.len() as u32, s.path),
        ),
        None => (typeless_data(&tex.image_data), streaming_info_inline()),
    };

    let value = Value::Seq(vec![
        string_value(&tex.name),                   // 0:  m_Name
        Value::Bool(false),                        // 1:  m_IsAlphaChannelOptional
        Value::I32(tex.width as i32),              // 2:  m_Width
        Value::I32(tex.height as i32),             // 3:  m_Height
        Value::U32(tex.image_data.len() as u32),   // 4:  m_CompleteImageSize
        Value::I32(0),                             // 5:  m_MipsStripped
        Value::I32(tex.texture_format),            // 6:  m_TextureFormat
        Value::I32(tex.mip_count),                 // 7:  m_MipCount
        Value::Bool(false),                        // 8:  m_IsReadable
        Value::Bool(false),                        // 9:  m_IsPreProcessed
        Value::Bool(false),                        // 10: m_IgnoreMipmapLimit
        string_value(""),                          // 11: m_MipmapLimitGroupName
        Value::Bool(false),                        // 12: m_StreamingMipmaps
        Value::I32(0),                             // 13: m_StreamingMipmapsPriority
        Value::I32(1),                             // 14: m_ImageCount
        Value::I32(TEXTURE_DIMENSION_2D),          // 15: m_TextureDimension
        gl_texture_settings_default(),             // 16: m_TextureSettings
        Value::I32(0),                             // 17: m_LightmapFormat
        Value::I32(tex.color_space),               // 18: m_ColorSpace
        typeless_data(&[]),                        // 19: m_PlatformBlob (empty)
        image_field,                               // 20: image data
        stream_field,                              // 21: m_StreamData
    ]);

    // Fail loudly on Unity-version field drift rather than emitting a
    // malformed object. (This is the check that caught the 2022.3→Unity 6
    // 24→22 field change.)
    if let Value::Seq(items) = &value {
        let expected = nodes[0].children.len();
        if items.len() != expected {
            return Err(SerializeError::Format(format!(
                "Texture2D builder has {} fields but the fixture's TypeTree has {expected} \
                 root children — Unity-version layout drift; update serialize_texture2d.",
                items.len()
            )));
        }
    }

    let mut writer = TypeTreeWriter::new(nodes);
    writer.write_root(&value)?;
    Ok(writer.finish())
}

/// Build the `m_TextureSettings` GLTextureSettings struct's Value.
/// Six i32 children: m_FilterMode, m_Aniso, m_MipBias (technically
/// float — Unity emits as f32), m_WrapU, m_WrapV, m_WrapW.
fn gl_texture_settings_default() -> Value {
    Value::Seq(vec![
        Value::I32(1),       // m_FilterMode: 1 = Bilinear
        Value::I32(1),       // m_Aniso: 1
        Value::F32(0.0),     // m_MipBias
        Value::I32(0),       // m_WrapU: 0 = Repeat
        Value::I32(0),       // m_WrapV: 0 = Repeat
        Value::I32(0),       // m_WrapW: 0 = Repeat
    ])
}

/// `string` in Unity TypeTrees is a wrapper with an Array child whose
/// type is "string" and whose own children are size:i32 + data:char[].
/// Our writer's `write_string_node` special-cases the `string` type
/// and emits (u32 length, bytes) directly. The Value variant for that
/// is `Value::String`.
fn string_value(s: &str) -> Value {
    Value::String(s.to_string())
}

/// TypelessData in Unity TypeTrees is an Array container whose element
/// is u8. Length-prefixed (u32 LE) + bytes. The TypeTree's node type
/// is "TypelessData" — our writer's `write_typeless` handles that.
fn typeless_data(bytes: &[u8]) -> Value {
    Value::Bytes(bytes.to_vec())
}

/// StreamingInfo struct for inline (non-streamed) textures: offset=0,
/// size=0, path="".
fn streaming_info_inline() -> Value {
    streaming_info(0, 0, "")
}

/// StreamingInfo struct (offset, size, path).
fn streaming_info(offset: u64, size: u32, path: &str) -> Value {
    Value::Seq(vec![
        Value::U64(offset),
        Value::U32(size),
        string_value(path),
    ])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decodes_png_to_bc7_with_mips() {
        // 2x2 red PNG — minimum reproducible source.
        let png_bytes = generate_test_png(2, 2);
        let tex = decode_to_texture2d("test", &png_bytes).unwrap();
        assert_eq!(tex.width, 2);
        assert_eq!(tex.height, 2);
        assert_eq!(tex.texture_format, TEXTURE_FORMAT_BC7);
        // 2x2 → mip levels 2x2, 1x1 = 2 levels; each pads to a 4x4 BC7
        // block (16 bytes), so 32 bytes total.
        assert_eq!(tex.mip_count, 2);
        assert_eq!(tex.image_data.len(), 32);
    }

    #[test]
    fn serialize_produces_nonempty_output() {
        // We can't byte-diff against a real bundle here (that's the
        // verify-texture binary's job). This test just confirms the
        // walker accepts our Value tree against the real Texture2D
        // TypeTree and produces some output. Fixtures are regenerated on
        // demand — skip when absent.
        let Some(db) = crate::encode::type_tree_db::load_fixture_with_class(28) else {
            eprintln!("skip: no Texture2D fixture (run scripts/regenerate-fixtures.sh)");
            return;
        };
        let tex = UnityTexture2D {
            name: "test".into(),
            width: 4,
            height: 4,
            texture_format: TEXTURE_FORMAT_RGBA32,
            mip_count: 1,
            color_space: 1,
            image_data: vec![0xff; 4 * 4 * 4], // 4x4 RGBA = 64 bytes
        };
        let bytes = serialize_texture2d(&tex, &db).unwrap();
        assert!(bytes.len() > 64, "serialized output suspiciously small: {}", bytes.len());
        // Bytes should contain "test" somewhere (the m_Name string).
        let found_name = bytes.windows(4).any(|w| w == b"test");
        assert!(found_name, "expected 'test' name in serialized output");
        // And the image bytes.
        let found_image = bytes.windows(16).any(|w| w.iter().all(|&b| b == 0xff));
        assert!(found_image, "expected image_data fill bytes in output");
    }

    fn generate_test_png(width: u32, height: u32) -> Vec<u8> {
        use image::{ImageBuffer, Rgba};
        let img: ImageBuffer<Rgba<u8>, _> =
            ImageBuffer::from_fn(width, height, |_, _| Rgba([255, 0, 0, 255]));
        let mut buf = Vec::new();
        img.write_to(&mut std::io::Cursor::new(&mut buf), image::ImageFormat::Png)
            .unwrap();
        buf
    }
}
