//! SerializedFile reader — extracts the type-table entries from a
//! Unity-built SerializedFile so we can vendor them as a TypeTree
//! fixture for the encoder.
//!
//! Reads exactly what we need (header + type table) and stops. Objects,
//! externals, ref-types tables are skipped — the extractor doesn't
//! care about them.
//!
//! Round-trip tested against our own writer in
//! `serialized_file.rs::write_serialized_file`. Correctness against a
//! Unity-built fixture is verified when `extract-typetrees` runs against
//! a production bundle.

use super::serialized_file::SERIALIZED_FILE_VERSION;
use super::SerializeError;

/// One extracted type-table entry — what we vendor into typetrees.bin
/// per class. `type_tree_blob` is the raw bytes from Unity's
/// SerializedFile, in the exact format our `parse_type_tree_nodes`
/// expects.
#[derive(Debug, Clone)]
pub struct ExtractedTypeEntry {
    pub class_id: i32,
    pub is_stripped: bool,
    pub script_id: [u8; 16],
    pub old_type_hash: [u8; 16],
    pub type_tree_blob: Vec<u8>,
}

/// Result of reading a SerializedFile — only the type table, which is
/// all the extractor needs. If we ever want to read more (for
/// debugging, verification), this struct grows.
#[derive(Debug)]
pub struct ParsedSerializedFile {
    pub unity_version: String,
    pub target_platform: i32,
    pub types: Vec<ExtractedTypeEntry>,
}

/// 48-byte header — verified field-by-field against a real Unity
/// 2022.3.12f1 production bundle. Layout:
///
/// ```text
///   0x00-0x03  u32 BE legacy metadata_size  (always 0 in v22+)
///   0x04-0x07  u32 BE legacy file_size      (always 0 in v22+)
///   0x08-0x0B  u32 BE version               (22 for Unity 2021.3, 2022.3)
///   0x0C-0x0F  u32 BE legacy data_offset    (always 0 in v22+)
///   0x10-0x17  i64 BE metadata_size         ← real value used by the loader
///   0x18-0x1F  i64 BE file_size             ← real value used by the loader
///   0x20-0x27  i64 BE data_offset           ← real value used by the loader
///   0x28       u8     endianness            (0 = little, for METADATA section)
///   0x29-0x2B  u8[3]  reserved              (zero)
///   0x2C-0x2F  u32    padding/unknown       (zero)
/// ```
///
/// All header fields are BIG-endian. The endianness byte at 0x28
/// controls the metadata section's encoding only — typically 0 (little)
/// in production. Metadata section starts at offset 48.
const HEADER_SIZE: usize = 48;

pub fn parse_serialized_file(bytes: &[u8]) -> Result<ParsedSerializedFile, SerializeError> {
    if bytes.len() < HEADER_SIZE {
        return Err(SerializeError::Format(format!(
            "SerializedFile too short for header: {} bytes (need {HEADER_SIZE})",
            bytes.len()
        )));
    }
    let version = u32::from_be_bytes(bytes[8..12].try_into().unwrap());
    let metadata_size = i64::from_be_bytes(bytes[0x10..0x18].try_into().unwrap()) as usize;
    let _file_size = i64::from_be_bytes(bytes[0x18..0x20].try_into().unwrap()) as usize;
    let _data_offset = i64::from_be_bytes(bytes[0x20..0x28].try_into().unwrap()) as usize;
    let endianness = bytes[0x28];
    if endianness != 0 {
        return Err(SerializeError::Format(format!(
            "SerializedFile big-endian variant not supported (endianness byte = {endianness})"
        )));
    }
    if version != SERIALIZED_FILE_VERSION {
        // Future Unity versions may bump this. We log via the error
        // message rather than refusing outright so a slightly mismatched
        // bundle still surfaces useful diagnostics. The caller decides
        // whether to proceed.
        return Err(SerializeError::Format(format!(
            "SerializedFile version {version} != expected {SERIALIZED_FILE_VERSION} \
             (extractor was built for Unity 2021.3; re-check the bundle's Unity version)"
        )));
    }

    let metadata_start = HEADER_SIZE;
    let metadata_end = metadata_start
        .checked_add(metadata_size)
        .ok_or_else(|| SerializeError::Format("metadata_size overflow".into()))?;
    if metadata_end > bytes.len() {
        return Err(SerializeError::Format(format!(
            "metadata section overruns file ({metadata_end} > {})",
            bytes.len()
        )));
    }
    let metadata = &bytes[metadata_start..metadata_end];

    // Parse the metadata section, LE.
    let mut cur = 0usize;

    let (unity_version, n) = read_cstring(&metadata[cur..])?;
    cur += n;

    let target_platform = i32::from_le_bytes(metadata[cur..cur + 4].try_into().unwrap());
    cur += 4;

    let enable_type_tree = metadata[cur] != 0;
    cur += 1;
    if !enable_type_tree {
        // Bundles built with BuildAssetBundleOptions.DisableWriteTypeTree
        // strip the TypeTree. We can't use those for extraction — pick a
        // different bundle. Production Unity builds include TypeTrees by
        // default.
        return Err(SerializeError::Format(
            "SerializedFile has enable_type_tree=false; pick a bundle whose Unity build did NOT \
             set BuildAssetBundleOptions.DisableWriteTypeTree (production bundles include TypeTrees \
             by default)".into(),
        ));
    }

    let type_count = i32::from_le_bytes(metadata[cur..cur + 4].try_into().unwrap()) as usize;
    cur += 4;

    let mut types = Vec::with_capacity(type_count);
    for _ in 0..type_count {
        // Per-type record layout (verified against Unity 2022.3.12f1):
        //   i32 LE class_id
        //   u8    is_stripped
        //   i16 LE script_type_index   (-1 for non-MonoBehaviour)
        //   IF script_type_index >= 0: u8[16] script_id
        //   u8[16] old_type_hash
        //   bytes   type_tree_blob
        // The conditional script_id presence is the key spec
        // detail — readers that always read 16 bytes for script_id
        // (including this code's previous version) interpret the
        // following 16 bytes of old_type_hash as a phantom script_id,
        // then read 16 bytes of TypeTree blob header as the
        // old_type_hash, then bogus-parse the rest of the blob.
        let class_id = i32::from_le_bytes(metadata[cur..cur + 4].try_into().unwrap());
        cur += 4;
        let is_stripped = metadata[cur] != 0;
        cur += 1;
        let script_type_index = i16::from_le_bytes(metadata[cur..cur + 2].try_into().unwrap());
        cur += 2;
        let mut script_id = [0u8; 16];
        if script_type_index >= 0 {
            script_id.copy_from_slice(&metadata[cur..cur + 16]);
            cur += 16;
        }
        let mut old_type_hash = [0u8; 16];
        old_type_hash.copy_from_slice(&metadata[cur..cur + 16]);
        cur += 16;

        // The TypeTree blob is variable-length and self-delimiting:
        //   u32 LE node_count
        //   u32 LE string_buffer_size
        //   node records (32 bytes each)
        //   string buffer bytes
        //   u32 LE type_dependencies_count
        //   i32 LE dependencies[type_dependencies_count]
        //
        // The dependencies field was added in format >= 22 — earlier
        // versions of this code missed it, mis-aligning the read of
        // every type entry after the first. Verified against a real
        // Unity 2022.3.12f1 bundle: type[0]'s blob ends 4 bytes past
        // the string buffer, with bytes `00 00 00 00` (dependencies
        // count = 0).
        let blob_start = cur;
        let blob_node_count = u32::from_le_bytes(metadata[cur..cur + 4].try_into().unwrap()) as usize;
        let blob_string_buf_size =
            u32::from_le_bytes(metadata[cur + 4..cur + 8].try_into().unwrap()) as usize;
        let header_and_records_end = 4 + 4 + (blob_node_count * 32) + blob_string_buf_size;
        // Read the dependencies count to compute the rest of the blob.
        let dep_count_off = cur + header_and_records_end;
        if dep_count_off + 4 > metadata.len() {
            return Err(SerializeError::Format(format!(
                "type {class_id} TypeTree blob truncated before dependencies count"
            )));
        }
        let dep_count =
            u32::from_le_bytes(metadata[dep_count_off..dep_count_off + 4].try_into().unwrap())
                as usize;
        let blob_size = header_and_records_end + 4 + (dep_count * 4);
        let blob_end = blob_start
            .checked_add(blob_size)
            .ok_or_else(|| SerializeError::Format("type_tree_blob size overflow".into()))?;
        if blob_end > metadata.len() {
            return Err(SerializeError::Format(format!(
                "type_tree_blob for class {class_id} ({blob_size} bytes) overruns metadata section"
            )));
        }
        let blob = metadata[blob_start..blob_end].to_vec();
        cur = blob_end;

        types.push(ExtractedTypeEntry {
            class_id,
            is_stripped,
            script_id,
            old_type_hash,
            type_tree_blob: blob,
        });
    }

    Ok(ParsedSerializedFile {
        unity_version,
        target_platform,
        types,
    })
}

fn read_cstring(bytes: &[u8]) -> Result<(String, usize), SerializeError> {
    let null_idx = bytes
        .iter()
        .position(|&b| b == 0)
        .ok_or_else(|| SerializeError::Format("unterminated cstring".into()))?;
    let s = std::str::from_utf8(&bytes[..null_idx])
        .map_err(|e| SerializeError::Format(format!("invalid utf8 in cstring: {e}")))?
        .to_string();
    Ok((s, null_idx + 1))
}

// ---------------------------------------------------------------------------
// Tests — round-trip against our own writer.
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::encode::serialized_file::{
        target, write_serialized_file, ExternalEntry, ObjectEntry, SerializedFileInput, TypeEntry,
    };

    #[test]
    fn round_trip_empty_file_recovers_zero_types() {
        let bytes = write_serialized_file(&SerializedFileInput {
            unity_version: "2021.3.20f1",
            target_platform: target::STANDALONE_WINDOWS_64,
            types: vec![],
            objects: vec![],
            externals: vec![],
        })
        .unwrap();
        let parsed = parse_serialized_file(&bytes).unwrap();
        assert_eq!(parsed.unity_version, "2021.3.20f1");
        assert_eq!(parsed.target_platform, target::STANDALONE_WINDOWS_64);
        assert!(parsed.types.is_empty());
    }

    #[test]
    fn round_trip_recovers_typetree_blob() {
        // Hand-built minimal TypeTree blob: 1 node, no string buffer.
        // Same shape as the parse_type_tree_nodes test fixture.
        let mut tt_blob = Vec::new();
        tt_blob.extend_from_slice(&1u32.to_le_bytes()); // node_count
        tt_blob.extend_from_slice(&0u32.to_le_bytes()); // string_buffer_size
        // One 32-byte node record (mostly zeros — the test cares about
        // the blob bytes round-tripping, not their semantics).
        tt_blob.extend_from_slice(&[0u8; 32]);
        // Format >= 22 trailer: type_dependencies_count u32 LE,
        // followed by `dependencies_count` * 4 bytes of i32 LE
        // dependency class IDs. Zero deps is the production-common
        // case.
        tt_blob.extend_from_slice(&0u32.to_le_bytes());

        let bytes = write_serialized_file(&SerializedFileInput {
            unity_version: "2021.3.20f1",
            target_platform: target::STANDALONE_WINDOWS_64,
            types: vec![TypeEntry {
                class_id: 28, // Texture2D
                is_stripped: false,
                script_id: [0; 16],
                old_type_hash: [0x42; 16],
                type_tree_blob: tt_blob.clone(),
            }],
            objects: vec![ObjectEntry {
                path_id: 1,
                type_index: 0,
                data: b"x".to_vec(),
            }],
            externals: vec![],
        })
        .unwrap();

        let parsed = parse_serialized_file(&bytes).unwrap();
        assert_eq!(parsed.types.len(), 1);
        let t = &parsed.types[0];
        assert_eq!(t.class_id, 28);
        assert!(!t.is_stripped);
        assert_eq!(t.old_type_hash, [0x42; 16]);
        assert_eq!(t.type_tree_blob, tt_blob);
    }

    #[test]
    fn rejects_disable_write_type_tree_bundle() {
        // Build a bundle whose enable_type_tree flag is false. Our
        // writer only emits true (when types is non-empty) so we can't
        // produce this directly — patch the bytes.
        let mut bytes = write_serialized_file(&SerializedFileInput {
            unity_version: "2021.3.20f1",
            target_platform: target::STANDALONE_WINDOWS_64,
            types: vec![],
            objects: vec![],
            externals: vec![],
        })
        .unwrap();

        // Find the enable_type_tree byte: right after the unity_version
        // cstring + target_platform i32 in the metadata section. Metadata
        // starts at offset HEADER_SIZE; unity_version is "2021.3.20f1\0"
        // = 12 bytes; target_platform is 4 bytes; flag is right after.
        let flag_offset = HEADER_SIZE + "2021.3.20f1\0".len() + 4;
        bytes[flag_offset] = 0; // disable

        let err = parse_serialized_file(&bytes).unwrap_err();
        assert!(matches!(err, SerializeError::Format(_)));
        let msg = format!("{err:?}");
        assert!(msg.contains("enable_type_tree"));
    }

    #[test]
    fn rejects_big_endian_variant() {
        let mut bytes = write_serialized_file(&SerializedFileInput {
            unity_version: "2021.3.20f1",
            target_platform: target::STANDALONE_WINDOWS_64,
            types: vec![],
            objects: vec![],
            externals: vec![],
        })
        .unwrap();
        bytes[0x28] = 1; // endianness byte at 0x28 (verified position)
        let err = parse_serialized_file(&bytes).unwrap_err();
        assert!(matches!(err, SerializeError::Format(_)));
    }
}
