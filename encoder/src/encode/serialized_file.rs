//! SerializedFile writer — the inner container that lives inside each
//! UnityFS data node and carries the actual Unity objects.
//!
//! ⚠️ STATUS — spec-derived, NOT verified against a Unity-built fixture.
//! Field layout comes from AssetRipper's SerializedFile reader (Unity
//! version 2021.3 → format version 22). Reader-against-our-writer
//! round-trip is verified; Unity-loader acceptance is not.
//!
//! Reference: github.com/AssetRipper/AssetRipper/tree/master/Source/AssetRipper.IO.Files/SerializedFiles
//!
//! Layout summary (format 22, little-endian for everything below the
//! header except the legacy file-size field):
//!
//! ```text
//!   Header (20 bytes):
//!     u32 BE metadata_size      ← length of the metadata section
//!     u32 BE file_size          ← total SerializedFile size (legacy 32b form)
//!     u32 BE version            ← format version, 22 for Unity 2021.3
//!     u32 BE data_offset        ← offset of the object-data section
//!     u8     endianness         ← 0 = little (we always write 0)
//!     u8[3]  reserved           ← zeros
//!     i64 LE metadata_size_v22  ← duplicate of metadata_size as i64 (format ≥ 22)
//!     i64 LE file_size_v22      ← duplicate of file_size as i64
//!     i64 LE data_offset_v22    ← duplicate of data_offset as i64
//!     i64 LE unknown            ← zero
//!
//!   Metadata (all LE from here):
//!     cstring unity_version     ← "2021.3.20f1\0"
//!     i32     target_platform   ← BuildTarget enum value (e.g. 19 for Windows64)
//!     u8      enable_type_tree  ← 1 for our bundles
//!
//!     i32     type_count
//!       per type: { i32 class_id, u8 is_stripped, i16 script_type_idx, ... typetree blob ... }
//!
//!     i32     object_count
//!       per object: aligned to 4-byte boundary, then
//!         i64 path_id, i64 byte_start, u32 byte_size, i32 type_index
//!
//!     i32     script_count       ← 0 for our bundles (no MonoScripts)
//!     i32     externals_count
//!       per external: { cstring(""), u8[16] guid, i32 type, cstring path }
//!     i32     ref_types_count    ← 0
//!     cstring user_information   ← ""
//!
//!   Object data (at data_offset):
//!     each object's pre-serialised bytes, aligned to 8 bytes between them.
//! ```

use std::io::Write;

use super::unityfs_writer::{write_cstring, write_i64_be, write_u32_be};
use super::SerializeError;

/// Format version we target. Unity 2021.3.x emits version 22.
pub const SERIALIZED_FILE_VERSION: u32 = 22;

/// Build-target ints — match Unity's `BuildTarget` enum at runtime.
/// AssetRipper's `BuildTarget.cs` is the canonical reference.
pub mod target {
    pub const STANDALONE_OSX: i32 = 2;
    pub const STANDALONE_WINDOWS_64: i32 = 19;
    pub const WEBGL: i32 = 20;
}

pub fn unity_target_id_for(target: crate::types::BuildTarget) -> i32 {
    match target {
        crate::types::BuildTarget::Windows => target::STANDALONE_WINDOWS_64,
        crate::types::BuildTarget::Mac => target::STANDALONE_OSX,
        crate::types::BuildTarget::Webgl => target::WEBGL,
    }
}

// ---------------------------------------------------------------------------
// Input types
// ---------------------------------------------------------------------------

pub struct SerializedFileInput<'a> {
    pub unity_version: &'a str,
    pub target_platform: i32,
    pub types: Vec<TypeEntry>,
    pub objects: Vec<ObjectEntry>,
    pub externals: Vec<ExternalEntry>,
}

#[derive(Debug, Clone)]
pub struct TypeEntry {
    pub class_id: i32,
    pub is_stripped: bool,
    /// 16-byte script ID hash — zeros for non-MonoBehaviour types.
    pub script_id: [u8; 16],
    /// 16-byte type tree hash — Unity caches by this. Zeros are accepted
    /// by the loader; production bundles emit a real digest. Caller can
    /// supply zeros until a TypeTreeDb is wired in.
    pub old_type_hash: [u8; 16],
    /// Raw TypeTree binary blob for this class. When the encoder runs
    /// without a TypeTree fixture this is empty; readers tolerate
    /// empty TypeTrees on stripped types.
    pub type_tree_blob: Vec<u8>,
}

#[derive(Debug, Clone)]
pub struct ObjectEntry {
    pub path_id: i64,
    /// Index into `types`. The header records type-by-index so we
    /// don't repeat per-class metadata.
    pub type_index: i32,
    /// Pre-serialised bytes for this object (output of the per-class
    /// writers in mesh.rs / material.rs / texture.rs).
    pub data: Vec<u8>,
}

#[derive(Debug, Clone)]
pub struct ExternalEntry {
    /// 16-byte asset GUID. For DCL shader references, this is the
    /// shader's GUID from the bake-time `shader-guids.json`.
    pub guid: [u8; 16],
    /// Unity ClassID for the external. Shader = 3.
    pub type_id: i32,
    /// Path of the external file. Empty for GUID-resolved externals
    /// (which is how shader refs work — the GUID is enough).
    pub path: String,
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

fn write_u8<W: Write>(w: &mut W, v: u8) -> Result<(), SerializeError> {
    w.write_all(&[v]).map_err(SerializeError::from)
}

fn write_i16_le<W: Write>(w: &mut W, v: i16) -> Result<(), SerializeError> {
    w.write_all(&v.to_le_bytes()).map_err(SerializeError::from)
}

fn write_i32_le<W: Write>(w: &mut W, v: i32) -> Result<(), SerializeError> {
    w.write_all(&v.to_le_bytes()).map_err(SerializeError::from)
}

fn write_i64_le<W: Write>(w: &mut W, v: i64) -> Result<(), SerializeError> {
    w.write_all(&v.to_le_bytes()).map_err(SerializeError::from)
}

fn align_to<W: Write>(w: &mut W, written: &mut usize, alignment: usize) -> Result<(), SerializeError> {
    let pad = (alignment - (*written % alignment)) % alignment;
    if pad > 0 {
        let zeros = vec![0u8; pad];
        w.write_all(&zeros)?;
        *written += pad;
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Top-level writer
// ---------------------------------------------------------------------------

pub fn write_serialized_file(input: &SerializedFileInput<'_>) -> Result<Vec<u8>, SerializeError> {
    // Layout strategy:
    //   1. Write metadata to a temporary buffer (we don't know its size
    //      until we've written everything except the header).
    //   2. Compute object_data layout (object byte_start values are
    //      relative to data_offset; data_offset == header_size + metadata_size,
    //      aligned to 16 bytes per Unity convention).
    //   3. Write the final file: header → metadata → padding → object data.
    let mut metadata = Vec::with_capacity(1024);
    write_metadata(&mut metadata, input)?;

    // Header is 48 bytes for format 22 — verified against a real Unity
    // 2022.3.12f1 bundle. Layout:
    //   * legacy u32 BE x4 (always 0 in v22+; the i64 fields below
    //     carry the real values): metadata_size, file_size, version,
    //     data_offset (0x00-0x0F)
    //   * i64 BE metadata_size (0x10-0x17)
    //   * i64 BE file_size (0x18-0x1F)
    //   * i64 BE data_offset (0x20-0x27)
    //   * endianness u8 (0x28) — controls METADATA section only;
    //     the header itself is BIG-endian regardless
    //   * reserved[3] (0x29-0x2B)
    //   * u32 BE padding/unknown (0x2C-0x2F) — zero in production
    //
    // (Earlier iterations of this code used 52 bytes with 4 i64 LE
    // fields. Both were wrong; round-trip tests passed because reader
    // and writer were consistently wrong together.)
    const HEADER_SIZE: usize = 48;
    let metadata_size = metadata.len();
    // Unity 16-byte aligns the object data section after the metadata.
    let data_offset = align_up(HEADER_SIZE + metadata_size, 16);

    // Compute per-object byte_start (offset within the object data
    // section). Re-walk the object list to compute, then patch the
    // object entries' offsets back into the metadata. Easier: re-emit
    // the metadata once we know offsets.
    //
    // To keep this single-pass, we write the metadata with the object
    // table empty, compute the data layout, then patch. That's fiddly;
    // simpler to write metadata twice — once to size, once for real.
    let object_layouts = compute_object_layouts(&input.objects);

    let mut metadata_final = Vec::with_capacity(metadata.len());
    write_metadata_with_layouts(&mut metadata_final, input, &object_layouts)?;
    debug_assert_eq!(
        metadata_final.len(),
        metadata.len(),
        "metadata size changed between passes (a writer is sensitive to object byte_starts where it shouldn't be)"
    );

    // Compute total file size: data_offset + sum(object sizes + alignment padding).
    let total_object_data_size = object_layouts
        .last()
        .map(|l| l.byte_start as usize + l.byte_size as usize)
        .unwrap_or(0);
    let total_file_size = data_offset + total_object_data_size;

    // Assemble.
    let mut out = Vec::with_capacity(total_file_size);
    write_header(&mut out, metadata_size, total_file_size, data_offset)?;
    out.extend_from_slice(&metadata_final);
    // Pad to data_offset.
    while out.len() < data_offset {
        out.push(0);
    }
    // Object data.
    for (obj, layout) in input.objects.iter().zip(object_layouts.iter()) {
        // Each object is written at its computed byte_start (relative
        // to data_offset). Pad if we drifted.
        let absolute_start = data_offset + layout.byte_start as usize;
        while out.len() < absolute_start {
            out.push(0);
        }
        out.extend_from_slice(&obj.data);
    }

    Ok(out)
}

fn align_up(n: usize, alignment: usize) -> usize {
    let r = n % alignment;
    if r == 0 {
        n
    } else {
        n + (alignment - r)
    }
}

#[derive(Debug, Clone, Copy)]
struct ObjectLayout {
    byte_start: u64,
    byte_size: u32,
}

fn compute_object_layouts(objects: &[ObjectEntry]) -> Vec<ObjectLayout> {
    let mut layouts = Vec::with_capacity(objects.len());
    let mut cursor: u64 = 0;
    for obj in objects {
        // 8-byte align each object's start within the data section —
        // matches Unity's writer.
        let pad = (8 - (cursor % 8)) % 8;
        cursor += pad;
        layouts.push(ObjectLayout {
            byte_start: cursor,
            byte_size: obj.data.len() as u32,
        });
        cursor += obj.data.len() as u64;
    }
    layouts
}

// ---------------------------------------------------------------------------
// Header (48 bytes, format 22)
// ---------------------------------------------------------------------------

fn write_header(
    out: &mut Vec<u8>,
    metadata_size: usize,
    total_file_size: usize,
    data_offset: usize,
) -> Result<(), SerializeError> {
    // Layout verified against real Unity 2022.3.12f1 bundle. See the
    // module doc at the top of this file for the full byte map.
    //
    //   0x00-0x0F: legacy u32 BE x4, all zero in v22+
    write_u32_be(out, 0)?; // legacy metadata_size
    write_u32_be(out, 0)?; // legacy file_size
    write_u32_be(out, SERIALIZED_FILE_VERSION)?;
    write_u32_be(out, 0)?; // legacy data_offset
    //   0x10-0x27: three i64 BE fields the loader actually reads
    write_i64_be(out, metadata_size as i64)?;
    write_i64_be(out, total_file_size as i64)?;
    write_i64_be(out, data_offset as i64)?;
    //   0x28: endianness u8 — controls metadata section encoding only,
    //   not the header itself (header is always BE)
    write_u8(out, 0)?;
    //   0x29-0x2B: reserved[3]
    write_u8(out, 0)?;
    write_u8(out, 0)?;
    write_u8(out, 0)?;
    //   0x2C-0x2F: padding/unknown — zero in production
    write_u32_be(out, 0)?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Metadata block (LE everywhere below the header)
// ---------------------------------------------------------------------------

fn write_metadata(out: &mut Vec<u8>, input: &SerializedFileInput<'_>) -> Result<(), SerializeError> {
    // First pass — emit zero offsets for objects; result is purely for sizing.
    let zero_layouts: Vec<ObjectLayout> = input
        .objects
        .iter()
        .map(|o| ObjectLayout {
            byte_start: 0,
            byte_size: o.data.len() as u32,
        })
        .collect();
    write_metadata_with_layouts(out, input, &zero_layouts)
}

fn write_metadata_with_layouts(
    out: &mut Vec<u8>,
    input: &SerializedFileInput<'_>,
    layouts: &[ObjectLayout],
) -> Result<(), SerializeError> {
    write_cstring(out, input.unity_version)?;
    write_i32_le(out, input.target_platform)?;
    // enable_type_tree is always 1 for our bundles. Production Unity
    // builds emit it set unless explicitly built with
    // `BuildAssetBundleOptions.DisableWriteTypeTree`, which we never
    // do — the Explorer's loader requires inline TypeTrees per
    // `LoadAssetBundleSystem.cs` (the manifest version gate).
    write_u8(out, 1)?;

    write_i32_le(out, input.types.len() as i32)?;
    for t in &input.types {
        write_i32_le(out, t.class_id)?;
        write_u8(out, if t.is_stripped { 1 } else { 0 })?;
        // script_type_index: -1 for non-MonoBehaviour types. We never
        // emit MonoBehaviours from this writer (the inline metadata.json
        // TextAsset is a TextAsset, not a MonoBehaviour), so this is
        // always -1.
        write_i16_le(out, -1)?;
        // script_id (16 bytes) — ONLY emitted when script_type_index
        // >= 0. For non-MonoBehaviour types (always the case in our
        // writer) the field is absent from the record. Verified
        // against a real Unity 2022.3.12f1 bundle: emitting an
        // unconditional 16-byte script_id mis-aligns every subsequent
        // type entry by 16 bytes.
        //   (no script_id write)
        // old_type_hash (16 bytes)
        out.extend_from_slice(&t.old_type_hash);
        // TypeTree blob. For format ≥ 22 this is the parsed TypeTree
        // nodes followed by their string blob — the layout is module-
        // private to type_tree.rs. Empty blob is legal for stripped
        // types; readers tolerate it.
        out.extend_from_slice(&t.type_tree_blob);
    }

    // Object table — each entry 4-byte aligned per Unity convention
    // (object table is the only metadata section with internal
    // alignment).
    write_i32_le(out, input.objects.len() as i32)?;
    let mut written_in_section = 4usize; // count includes the i32 above
    for (obj, layout) in input.objects.iter().zip(layouts.iter()) {
        align_to(out, &mut written_in_section, 4)?;
        let start_len = out.len();
        write_i64_le(out, obj.path_id)?;
        write_i64_le(out, layout.byte_start as i64)?;
        // byte_size is u32 LE — the entire metadata section is LE per
        // the endianness byte at header offset 0x28. Earlier iteration
        // of this code used BE; that bug was caught by the
        // verify-texture-bundle harness.
        write_i32_le(out, layout.byte_size as i32)?;
        write_i32_le(out, obj.type_index)?;
        written_in_section += out.len() - start_len;
    }

    // Script types — none.
    write_i32_le(out, 0)?;

    // Externals table.
    write_i32_le(out, input.externals.len() as i32)?;
    for ext in &input.externals {
        // First cstring is the asset path — empty for guid-resolved
        // externals (shaders).
        write_cstring(out, "")?;
        out.extend_from_slice(&ext.guid);
        write_i32_le(out, ext.type_id)?;
        write_cstring(out, &ext.path)?;
    }

    // Ref types — none.
    write_i32_le(out, 0)?;

    // User information — empty.
    write_cstring(out, "")?;

    Ok(())
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    /// Read the real (i64 BE) sizes from the SerializedFile header.
    /// The legacy u32 BE fields at 0x00-0x0F are zero in v22+ bundles
    /// — Unity reads the i64 BE fields at 0x10/0x18/0x20 instead
    /// (verified against a real 2022.3.12f1 bundle).
    fn header_metadata_size(b: &[u8]) -> usize {
        i64::from_be_bytes(b[0x10..0x18].try_into().unwrap()) as usize
    }
    fn header_file_size(b: &[u8]) -> usize {
        i64::from_be_bytes(b[0x18..0x20].try_into().unwrap()) as usize
    }
    fn header_data_offset(b: &[u8]) -> usize {
        i64::from_be_bytes(b[0x20..0x28].try_into().unwrap()) as usize
    }

    #[test]
    fn empty_file_has_valid_header() {
        let bytes = write_serialized_file(&SerializedFileInput {
            unity_version: "2021.3.20f1",
            target_platform: target::STANDALONE_WINDOWS_64,
            types: vec![],
            objects: vec![],
            externals: vec![],
        })
        .unwrap();

        let version = u32::from_be_bytes(bytes[8..12].try_into().unwrap());
        let endianness = bytes[0x28];
        let metadata_size = header_metadata_size(&bytes);
        let file_size = header_file_size(&bytes);
        let data_offset = header_data_offset(&bytes);

        assert_eq!(version, SERIALIZED_FILE_VERSION);
        assert_eq!(endianness, 0);
        assert!(metadata_size > 0);
        assert!(file_size >= 48 + metadata_size);
        assert!(data_offset >= 48 + metadata_size);
        assert_eq!(data_offset % 16, 0);

        // Legacy u32 BE fields should be zero in v22+ — matches real
        // Unity 2022.3.x bundles.
        assert_eq!(u32::from_be_bytes(bytes[0..4].try_into().unwrap()), 0);
        assert_eq!(u32::from_be_bytes(bytes[4..8].try_into().unwrap()), 0);
        assert_eq!(u32::from_be_bytes(bytes[12..16].try_into().unwrap()), 0);
    }

    #[test]
    fn data_offset_is_16_byte_aligned() {
        let bytes = write_serialized_file(&SerializedFileInput {
            unity_version: "2021.3.20f1",
            target_platform: target::STANDALONE_WINDOWS_64,
            types: vec![],
            objects: vec![ObjectEntry {
                path_id: 1,
                type_index: 0,
                data: b"hello".to_vec(),
            }],
            externals: vec![],
        })
        .unwrap();
        assert_eq!(header_data_offset(&bytes) % 16, 0);
    }

    #[test]
    fn object_data_appears_at_data_offset() {
        let payload = b"test-object-payload".to_vec();
        let bytes = write_serialized_file(&SerializedFileInput {
            unity_version: "2021.3.20f1",
            target_platform: target::STANDALONE_WINDOWS_64,
            types: vec![TypeEntry {
                class_id: 49, // TextAsset
                is_stripped: true,
                script_id: [0; 16],
                old_type_hash: [0; 16],
                type_tree_blob: vec![],
            }],
            objects: vec![ObjectEntry {
                path_id: 1,
                type_index: 0,
                data: payload.clone(),
            }],
            externals: vec![],
        })
        .unwrap();
        let data_offset = header_data_offset(&bytes);
        assert_eq!(&bytes[data_offset..data_offset + payload.len()], &payload[..]);
    }

    #[test]
    fn externals_are_emitted_with_correct_guid() {
        let mut guid = [0u8; 16];
        // Realistic DCL/Scene GUID byte layout (32 hex → 16 bytes).
        for (i, byte_pair) in "56a9743f8d94f684190dc11bb521fb78".as_bytes().chunks(2).enumerate() {
            let hex = std::str::from_utf8(byte_pair).unwrap();
            guid[i] = u8::from_str_radix(hex, 16).unwrap();
        }
        let bytes = write_serialized_file(&SerializedFileInput {
            unity_version: "2021.3.20f1",
            target_platform: target::STANDALONE_WINDOWS_64,
            types: vec![],
            objects: vec![],
            externals: vec![ExternalEntry {
                guid,
                type_id: 3, // Shader
                path: String::new(),
            }],
        })
        .unwrap();
        // We can't read it back without a paired reader, but we can
        // search for the GUID bytes — they must be present somewhere
        // in the metadata section.
        let metadata_size = header_metadata_size(&bytes);
        let metadata = &bytes[48..48 + metadata_size];
        let found = metadata.windows(16).any(|w| w == guid);
        assert!(found, "external GUID bytes not found in metadata section");
    }
}
