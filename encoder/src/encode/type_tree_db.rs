//! TypeTree database — parsed from the vendored typetrees.bin fixture
//! at encoder startup. Per-class writers look up their TypeTree by
//! class_id at encode time.
//!
//! Built from the output of `extract-typetrees` against a real Unity
//! bundle. The bytes inside each entry's `type_tree_blob` ARE the
//! Unity wire format — `parse_type_tree_nodes` (in type_tree.rs) reads
//! them directly. We just package the per-class entries here.

use std::collections::HashMap;

use super::serialized_file_reader::ExtractedTypeEntry;
use super::type_tree::{parse_type_tree_nodes, TypeTreeNode};
use super::typetree_fixture::parse_fixture;
use super::SerializeError;

#[derive(Debug)]
pub struct TypeTreeDb {
    pub unity_version: String,
    /// Per-class parsed TypeTree nodes, ready for the writer to walk.
    pub by_class: HashMap<i32, Vec<TypeTreeNode>>,
    /// Per-class type-table metadata Unity needs to re-emit when our
    /// encoder writes a SerializedFile (old_type_hash matters because
    /// Unity uses it as a cache key on the loader side).
    pub by_class_meta: HashMap<i32, TypeMetadata>,
}

#[derive(Debug, Clone)]
pub struct TypeMetadata {
    pub is_stripped: bool,
    pub script_id: [u8; 16],
    pub old_type_hash: [u8; 16],
    pub raw_blob: Vec<u8>,
}

impl TypeTreeDb {
    /// Build a database from the on-disk typetrees.bin fixture bytes.
    pub fn from_fixture_bytes(bytes: &[u8]) -> Result<Self, SerializeError> {
        let fixture = parse_fixture(bytes)?;
        let mut by_class: HashMap<i32, Vec<TypeTreeNode>> = HashMap::new();
        let mut by_class_meta: HashMap<i32, TypeMetadata> = HashMap::new();
        for entry in &fixture.entries {
            let nodes = parse_type_tree_nodes(&entry.type_tree_blob)?;
            by_class.insert(entry.class_id, nodes);
            by_class_meta.insert(
                entry.class_id,
                TypeMetadata {
                    is_stripped: entry.is_stripped,
                    script_id: entry.script_id,
                    old_type_hash: entry.old_type_hash,
                    raw_blob: entry.type_tree_blob.clone(),
                },
            );
        }
        Ok(Self {
            unity_version: fixture.unity_version,
            by_class,
            by_class_meta,
        })
    }

    /// Look up the parsed TypeTree for a class. Returns None if the
    /// fixture doesn't cover it — the caller surfaces this as a
    /// configuration error (the bake step picked a bundle that doesn't
    /// exercise this class).
    pub fn get(&self, class_id: i32) -> Option<&[TypeTreeNode]> {
        self.by_class.get(&class_id).map(|v| v.as_slice())
    }

    pub fn meta(&self, class_id: i32) -> Option<&TypeMetadata> {
        self.by_class_meta.get(&class_id)
    }

    /// Class IDs the fixture covers — useful in error messages and
    /// startup logs.
    pub fn class_ids(&self) -> Vec<i32> {
        let mut ids: Vec<i32> = self.by_class.keys().copied().collect();
        ids.sort();
        ids
    }
}

/// Directory holding regenerable TypeTree fixtures (relative to the
/// crate root, where `cargo test`/`cargo run` execute).
pub const FIXTURE_DIR: &str = "baked-fixtures/typetrees";

/// Test / tooling helper: load the first fixture under `FIXTURE_DIR`
/// (any `*.bin`) that contains `required_class`.
///
/// Returns `None` when no suitable fixture is present — fixtures are
/// **gitignored and regenerated on demand** (`scripts/regenerate-fixtures.sh`),
/// so a fresh checkout legitimately has none. Tests treat `None` as
/// "skip" and verifier binaries print a clear "run regenerate-fixtures"
/// message. This keeps Unity-derived schema bytes out of version control
/// without breaking `cargo test` on a clean clone (hand-built TypeTree
/// tests still cover the core logic).
pub fn load_fixture_with_class(required_class: i32) -> Option<TypeTreeDb> {
    let mut paths: Vec<std::path::PathBuf> = std::fs::read_dir(FIXTURE_DIR)
        .ok()?
        .filter_map(|e| e.ok().map(|e| e.path()))
        .filter(|p| p.extension().map(|x| x == "bin").unwrap_or(false))
        .collect();
    // Deterministic order; merged fixtures (e.g. "6000.2.6f2.bin") sort
    // before split ones ("6000.2.6f2-glb.bin") so we prefer the complete
    // one when both exist.
    paths.sort();
    for p in paths {
        if let Ok(bytes) = std::fs::read(&p) {
            if let Ok(db) = TypeTreeDb::from_fixture_bytes(&bytes) {
                if db.get(required_class).is_some() {
                    return Some(db);
                }
            }
        }
    }
    None
}

/// Convenience: build a TypeTreeDb from a fixture entry list (used
/// when the caller has already parsed the fixture for some other
/// reason).
#[allow(dead_code)]
pub fn from_entries(
    unity_version: String,
    entries: &[ExtractedTypeEntry],
) -> Result<TypeTreeDb, SerializeError> {
    let mut by_class = HashMap::new();
    let mut by_class_meta = HashMap::new();
    for entry in entries {
        let nodes = parse_type_tree_nodes(&entry.type_tree_blob)?;
        by_class.insert(entry.class_id, nodes);
        by_class_meta.insert(
            entry.class_id,
            TypeMetadata {
                is_stripped: entry.is_stripped,
                script_id: entry.script_id,
                old_type_hash: entry.old_type_hash,
                raw_blob: entry.type_tree_blob.clone(),
            },
        );
    }
    Ok(TypeTreeDb {
        unity_version,
        by_class,
        by_class_meta,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn loads_real_fixture() {
        // Fixtures are gitignored + regenerated on demand; skip when
        // absent (a clean clone legitimately has none). Run
        // scripts/regenerate-fixtures.sh to exercise this fully.
        let Some(db) = load_fixture_with_class(43) else {
            eprintln!("skip loads_real_fixture: no fixture (run scripts/regenerate-fixtures.sh)");
            return;
        };
        // A glb bundle's TypeTree carries these classes.
        for class_id in [1, 4, 21, 23, 33, 43, 49, 142] {
            assert!(db.get(class_id).is_some(), "expected class {class_id} in fixture");
        }
    }
}
