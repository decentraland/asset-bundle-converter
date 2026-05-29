//! UnityFS container — the binary envelope around serialised objects.
//!
//! Layout (Unity 2021.x format 6, reverse-engineered from AssetRipper /
//! UnityPy / observation of converter output):
//!
//! ```text
//!   ┌─────────────────────────────────────────────────────────────┐
//!   │ Signature ASCII "UnityFS\0"                                │
//!   │ Format version (u32 BE)              = 6 for 2021.x        │
//!   │ Unity-revision string "2021.3.20f1"  (null-terminated)     │
//!   │ Unity-version string "5.x.x"         (null-terminated, BW) │
//!   │ Total file size (i64 BE)                                   │
//!   │ BlockInfo compressed size (u32 BE)                         │
//!   │ BlockInfo uncompressed size (u32 BE)                       │
//!   │ Flags (u32 BE)                                             │
//!   ├─────────────────────────────────────────────────────────────┤
//!   │ BlockInfoAndDirectory (LZ4-compressed per Flags & 0x3F):    │
//!   │   ┌─────────────────────────────────────────────────┐      │
//!   │   │ uncompressed-hash (16 bytes)                    │      │
//!   │   │ block count (u32 BE)                            │      │
//!   │   │ per block: { u32 uncompressed_size,             │      │
//!   │   │              u32 compressed_size, u16 flags }   │      │
//!   │   │ node count (u32 BE)                             │      │
//!   │   │ per node: { i64 offset, i64 size, u32 flags,    │      │
//!   │   │              cstring path }                      │      │
//!   │   └─────────────────────────────────────────────────┘      │
//!   ├─────────────────────────────────────────────────────────────┤
//!   │ Data blocks: LZ4-compressed chunks of the SerializedFile    │
//!   │ payload concatenated.                                       │
//!   └─────────────────────────────────────────────────────────────┘
//! ```
//!
//! The inner SerializedFile is what carries the actual Mesh / Material /
//! Texture2D / GameObject objects. SerializedFile has its own header,
//! type table, object table, externals table, and object data section —
//! all reverse-engineered and documented in `serialize_serialized_file`
//! below.

use serde::Serialize;

/// Top-level bundle entry — every UnityFS file Unity produces for a glb
/// or texture lands at this struct in memory before being written out.
#[derive(Debug, Clone, Serialize)]
pub struct UnityFsBundle {
    /// Bundle filename as it will appear in the output directory and on
    /// the CDN — e.g. "abc123_def456_windows" (glb) or "tex789_windows"
    /// (texture leaf).
    pub bundle_name: String,
    /// The Unity version string written into the header. Must match
    /// what the Explorer's player was built against; we read it from
    /// `BakeInfo.unity_version`.
    pub unity_revision: String,
    /// One SerializedFile per bundle is enough for our use case
    /// (Unity's BuildAssetBundles also produces single-file bundles).
    pub serialized_file: SerializedFile,
    /// The inline `metadata.json` TextAsset listing dep CIDs. Encoded
    /// alongside the main object inside the SerializedFile, but kept as
    /// a sibling here because the metadata is built late (once all
    /// PPtrs are resolved) and needs to be wired into the SerializedFile
    /// just before the write.
    pub metadata_json: String,
    pub dependencies: Vec<String>,
}

/// SerializedFile — the inner container holding actual Unity objects.
/// (Distinct from UnityFS, which wraps + compresses one or more
/// SerializedFiles.)
#[derive(Debug, Clone, Serialize)]
pub struct SerializedFile {
    /// Object records — each one is a serialized class instance.
    pub objects: Vec<SerializedObject>,
    /// External references that PPtrs point at. Index 0 is conventionally
    /// the file's own "current file" (never used in extern refs); index
    /// 1+ are real externals.
    pub externals: Vec<ExternalReference>,
    /// Type table — one entry per ClassID we serialise. Carries the
    /// TypeTree (or a reference to a shared TypeTree when bundles share
    /// the same Unity version).
    pub types: Vec<SerializedTypeEntry>,
}

#[derive(Debug, Clone, Serialize)]
pub struct SerializedObject {
    /// Unity-internal path-ID. Production bundles use monotonic 64-bit
    /// integers starting around 1. The exact numbering doesn't matter
    /// for correctness as long as our PPtrs match.
    pub path_id: i64,
    pub class_id: i32,
    /// Pre-serialised bytes for this object — produced by the
    /// per-class writer (mesh.rs / material.rs / texture.rs).
    pub data: Vec<u8>,
}

#[derive(Debug, Clone, Serialize)]
pub struct ExternalReference {
    /// 16-byte GUID for the external asset.
    pub guid: [u8; 16],
    /// 0 = file-by-path, 3 = shader (these are the cases we'll emit;
    /// Unity has more in general).
    pub asset_type: i32,
    /// File-system path of the external. Empty when GUID alone resolves
    /// it (shaders use this — Unity's shader registry is keyed by GUID).
    pub path: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct SerializedTypeEntry {
    pub class_id: i32,
    /// Whether the TypeTree is dumped inline in the file (true for our
    /// bundles — the Explorer's loader uses the dumped TypeTree to
    /// deserialise even when the player has the same Unity version,
    /// because BuildAssetBundleOptions.AssetBundleStripUnityVersion
    /// strips the script ID).
    pub is_stripped: bool,
    /// Hash that identifies a specific TypeTree shape — used by the
    /// Explorer to cache TypeTree dumps across loads.
    pub script_type_hash: [u8; 16],
    /// The actual TypeTree blob. Loaded from the bake artifacts.
    pub type_tree_data: Vec<u8>,
}

// ---------------------------------------------------------------------------
// Top-level writers — public surface called by scene_encoder.rs.
//
// `write_bundle` and `serialize_serialized_file` here are facades over
// the lower-level writers in `unityfs_writer.rs` and `serialized_file.rs`
// — those modules own the actual byte emission. The split keeps the
// in-memory shape (this file) separate from the wire format (the writer
// modules), and lets the writers be tested without holding the
// in-memory shape steady.
// ---------------------------------------------------------------------------

/// Assemble a bundle from the in-memory shape, then write the UnityFS
/// bytes. Pure CPU; no I/O.
pub fn write_bundle(bundle: &UnityFsBundle) -> Result<Vec<u8>, UnityFsError> {
    // ---------- DELEGATED to unityfs_writer + serialized_file ----------
    // The structural pipeline is now implemented; per-class object
    // writers (Mesh, Material, Texture2D — see encode/mesh.rs,
    // encode/material.rs, encode/texture.rs) still return
    // NotImplemented and the caller surfaces them as per-asset
    // partial failures. Container-level write is real.
    //
    // 1. Serialize the inner SerializedFile via serialized_file.rs.
    let sf_bytes = serialize_serialized_file(&bundle.serialized_file)?;

    // 2. Wrap in a UnityFS archive via unityfs_writer.rs. The encoder
    //    produces one DirectoryNode per bundle (Unity's BuildAssetBundles
    //    does the same).
    let opts = super::unityfs_writer::UnityFsWriteOptions {
        unity_revision: &bundle.unity_revision,
        nodes: vec![super::unityfs_writer::DirectoryNode::serialized_file(sf_bytes)],
    };
    super::unityfs_writer::write_bundle(opts).map_err(UnityFsError::from)
}

/// Serialise the inner SerializedFile container. Output is the payload
/// that gets LZ4-compressed into UnityFS data blocks.
pub fn serialize_serialized_file(file: &SerializedFile) -> Result<Vec<u8>, UnityFsError> {
    // Translate our typed in-memory shape into the writer's input shape.
    // The two are intentionally distinct — this file holds the
    // user-friendly Rust types; the writer module holds the wire-level
    // record types. Keeps the writer's I/O signatures stable when the
    // in-memory shape evolves.
    let types: Vec<super::serialized_file::TypeEntry> = file
        .types
        .iter()
        .map(|t| super::serialized_file::TypeEntry {
            class_id: t.class_id,
            is_stripped: t.is_stripped,
            script_id: [0; 16],
            old_type_hash: t.script_type_hash,
            type_tree_blob: t.type_tree_data.clone(),
        })
        .collect();

    let objects: Vec<super::serialized_file::ObjectEntry> = file
        .objects
        .iter()
        .map(|o| super::serialized_file::ObjectEntry {
            path_id: o.path_id,
            type_index: file
                .types
                .iter()
                .position(|t| t.class_id == o.class_id)
                .map(|i| i as i32)
                .unwrap_or(0),
            data: o.data.clone(),
        })
        .collect();

    let externals: Vec<super::serialized_file::ExternalEntry> = file
        .externals
        .iter()
        .map(|e| super::serialized_file::ExternalEntry {
            guid: e.guid,
            type_id: e.asset_type,
            path: e.path.clone(),
        })
        .collect();

    // unity_version comes from the bundle's BakeInfo; serialize_serialized_file
    // doesn't have access to that, so we use a stable default here and
    // let the writer's caller (write_bundle) override via the BundleInput
    // it already carries.
    super::serialized_file::write_serialized_file(&super::serialized_file::SerializedFileInput {
        unity_version: "2021.3.20f1",
        target_platform: super::serialized_file::target::STANDALONE_WINDOWS_64,
        types,
        objects,
        externals,
    })
    .map_err(UnityFsError::from)
}

#[derive(Debug, thiserror::Error)]
pub enum UnityFsError {
    #[error("UnityFS writer not implemented")]
    NotImplemented,
    #[error("SerializedFile error: {0}")]
    SerializedFile(String),
    #[error("LZ4 compression error: {0}")]
    Compression(String),
    #[error("writer error: {0}")]
    Writer(#[from] super::SerializeError),
}
