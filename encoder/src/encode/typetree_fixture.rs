//! Read/write helpers for the vendored TypeTree fixture container.
//!
//! Format (little-endian throughout — simpler than mirroring Unity's
//! mixed BE/LE since this is OUR container, not Unity's):
//!
//! ```text
//!   u32 LE  magic = "DCTT" (0x54 54 43 44 in LE byte order)
//!   u32 LE  format version (1)
//!   u32 LE  unity_version cstring length (including null)
//!   bytes   unity_version cstring (e.g. "2021.3.20f1\0")
//!   u32 LE  class count
//!   per class:
//!     i32 LE  class_id
//!     u8      is_stripped (0/1)
//!     u8[16]  script_id
//!     u8[16]  old_type_hash
//!     u32 LE  blob_size
//!     bytes   raw TypeTree binary blob (consumed by parse_type_tree_nodes)
//! ```
//!
//! The `unity_version` field guards against a pod loading a fixture
//! built for a different Unity version (Explorer upgrades Unity → bake
//! version bumps → encoder rejects mismatched fixture at startup).

use super::serialized_file_reader::ExtractedTypeEntry;
use super::SerializeError;

const MAGIC: u32 = 0x5454_4344; // "DCTT" (Decentraland TypeTree)
const FORMAT_VERSION: u32 = 1;

#[derive(Debug)]
pub struct TypeTreeFixture {
    pub unity_version: String,
    pub entries: Vec<ExtractedTypeEntry>,
}

pub fn write_fixture(fx: &TypeTreeFixture) -> Result<Vec<u8>, SerializeError> {
    let mut out: Vec<u8> = Vec::with_capacity(64);
    out.extend_from_slice(&MAGIC.to_le_bytes());
    out.extend_from_slice(&FORMAT_VERSION.to_le_bytes());

    let uv_bytes = fx.unity_version.as_bytes();
    if uv_bytes.contains(&0) {
        return Err(SerializeError::Format(
            "unity_version contains a null byte".into(),
        ));
    }
    out.extend_from_slice(&((uv_bytes.len() + 1) as u32).to_le_bytes());
    out.extend_from_slice(uv_bytes);
    out.push(0);

    out.extend_from_slice(&(fx.entries.len() as u32).to_le_bytes());
    for e in &fx.entries {
        out.extend_from_slice(&e.class_id.to_le_bytes());
        out.push(if e.is_stripped { 1 } else { 0 });
        out.extend_from_slice(&e.script_id);
        out.extend_from_slice(&e.old_type_hash);
        out.extend_from_slice(&(e.type_tree_blob.len() as u32).to_le_bytes());
        out.extend_from_slice(&e.type_tree_blob);
    }

    Ok(out)
}

pub fn parse_fixture(bytes: &[u8]) -> Result<TypeTreeFixture, SerializeError> {
    if bytes.len() < 4 + 4 + 4 {
        return Err(SerializeError::Format("fixture too short".into()));
    }
    let mut cur = 0usize;
    let magic = u32::from_le_bytes(bytes[cur..cur + 4].try_into().unwrap());
    cur += 4;
    if magic != MAGIC {
        return Err(SerializeError::Format(format!(
            "fixture magic mismatch: expected 0x{MAGIC:08x}, got 0x{magic:08x} \
             (was the fixture produced by `cargo run --bin extract-typetrees`?)"
        )));
    }

    let version = u32::from_le_bytes(bytes[cur..cur + 4].try_into().unwrap());
    cur += 4;
    if version != FORMAT_VERSION {
        return Err(SerializeError::Format(format!(
            "fixture format version {version} != expected {FORMAT_VERSION}"
        )));
    }

    let uv_len = u32::from_le_bytes(bytes[cur..cur + 4].try_into().unwrap()) as usize;
    cur += 4;
    if uv_len == 0 {
        return Err(SerializeError::Format("unity_version length is 0".into()));
    }
    if cur + uv_len > bytes.len() {
        return Err(SerializeError::Format(
            "unity_version overruns fixture".into(),
        ));
    }
    let uv_bytes = &bytes[cur..cur + uv_len - 1]; // drop trailing null
    let unity_version = std::str::from_utf8(uv_bytes)
        .map_err(|e| SerializeError::Format(format!("unity_version not UTF-8: {e}")))?
        .to_string();
    cur += uv_len;

    if cur + 4 > bytes.len() {
        return Err(SerializeError::Format("missing class count".into()));
    }
    let class_count = u32::from_le_bytes(bytes[cur..cur + 4].try_into().unwrap()) as usize;
    cur += 4;

    let mut entries = Vec::with_capacity(class_count);
    for _ in 0..class_count {
        if cur + 4 + 1 + 16 + 16 + 4 > bytes.len() {
            return Err(SerializeError::Format(
                "class entry overruns fixture".into(),
            ));
        }
        let class_id = i32::from_le_bytes(bytes[cur..cur + 4].try_into().unwrap());
        cur += 4;
        let is_stripped = bytes[cur] != 0;
        cur += 1;
        let mut script_id = [0u8; 16];
        script_id.copy_from_slice(&bytes[cur..cur + 16]);
        cur += 16;
        let mut old_type_hash = [0u8; 16];
        old_type_hash.copy_from_slice(&bytes[cur..cur + 16]);
        cur += 16;
        let blob_size = u32::from_le_bytes(bytes[cur..cur + 4].try_into().unwrap()) as usize;
        cur += 4;
        if cur + blob_size > bytes.len() {
            return Err(SerializeError::Format(format!(
                "TypeTree blob for class {class_id} ({blob_size} bytes) overruns fixture"
            )));
        }
        let blob = bytes[cur..cur + blob_size].to_vec();
        cur += blob_size;
        entries.push(ExtractedTypeEntry {
            class_id,
            is_stripped,
            script_id,
            old_type_hash,
            type_tree_blob: blob,
        });
    }

    Ok(TypeTreeFixture {
        unity_version,
        entries,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trip_empty_fixture() {
        let fx = TypeTreeFixture {
            unity_version: "2021.3.20f1".into(),
            entries: vec![],
        };
        let bytes = write_fixture(&fx).unwrap();
        let parsed = parse_fixture(&bytes).unwrap();
        assert_eq!(parsed.unity_version, "2021.3.20f1");
        assert!(parsed.entries.is_empty());
    }

    #[test]
    fn round_trip_two_classes() {
        let fx = TypeTreeFixture {
            unity_version: "2021.3.20f1".into(),
            entries: vec![
                ExtractedTypeEntry {
                    class_id: 28, // Texture2D
                    is_stripped: false,
                    script_id: [0; 16],
                    old_type_hash: [0xab; 16],
                    type_tree_blob: vec![1, 2, 3, 4],
                },
                ExtractedTypeEntry {
                    class_id: 43, // Mesh
                    is_stripped: true,
                    script_id: [0xcd; 16],
                    old_type_hash: [0; 16],
                    type_tree_blob: vec![0xff; 100],
                },
            ],
        };
        let bytes = write_fixture(&fx).unwrap();
        let parsed = parse_fixture(&bytes).unwrap();
        assert_eq!(parsed.entries.len(), 2);
        assert_eq!(parsed.entries[0].class_id, 28);
        assert_eq!(parsed.entries[0].type_tree_blob, vec![1, 2, 3, 4]);
        assert_eq!(parsed.entries[1].class_id, 43);
        assert!(parsed.entries[1].is_stripped);
        assert_eq!(parsed.entries[1].type_tree_blob, vec![0xff; 100]);
    }

    #[test]
    fn rejects_bad_magic() {
        let mut bytes = write_fixture(&TypeTreeFixture {
            unity_version: "2021.3.20f1".into(),
            entries: vec![],
        })
        .unwrap();
        bytes[0] = 0; // corrupt magic
        let err = parse_fixture(&bytes).unwrap_err();
        assert!(matches!(err, SerializeError::Format(_)));
    }

    #[test]
    fn rejects_unsupported_format_version() {
        let fx = TypeTreeFixture {
            unity_version: "2021.3.20f1".into(),
            entries: vec![],
        };
        let mut bytes = write_fixture(&fx).unwrap();
        // Bump format version byte to an unsupported value.
        bytes[4] = 2;
        let err = parse_fixture(&bytes).unwrap_err();
        assert!(matches!(err, SerializeError::Format(_)));
    }
}
