//! Encoder pipeline modules.
//!
//! The pipeline shape (per scene, after consumer-server has supplied
//! depsDigestByHash and the filter lists):
//!
//! ```text
//!   contentMap + assets ──► glb_parser ──► dep graph
//!                                          │
//!                                          ▼
//!                                       mesh.encode     ┐
//!                                       material.encode ├──► unityfs.write ──► bundle bytes
//!                                       texture.encode  ┘
//! ```
//!
//! Each submodule owns one phase of the pipeline. The traits / type
//! signatures here are settled; the actual binary writers are TODO blocks
//! pointing at the relevant reference material (Unity TypeTrees from a
//! TypeTreeGenerator dump, AssetRipper / UnityPy decompilation of a
//! reference bundle).

pub mod bundle_assembler;
pub mod class_writers;
pub mod glb_parser;
pub mod gltf_mesh;
pub mod material;
pub mod mesh;
pub mod serialized_file;
pub mod serialized_file_reader;
pub mod texture;
pub mod texture_writer;
pub mod type_tree;
pub mod type_tree_db;
pub mod typetree_fixture;
pub mod unityfs;
pub mod unityfs_writer;

/// Shared error type used by the binary writers. Distinct from
/// `EncoderError` because these errors are caught at the encoder
/// boundary and converted to `partial_failures` for the offending
/// asset — they don't bubble up as encoder-wide failures.
#[derive(Debug, thiserror::Error)]
pub enum SerializeError {
    #[error("format error: {0}")]
    Format(String),
    #[error("I/O error: {0}")]
    Io(#[from] std::io::Error),
    #[error("LZ4 error: {0}")]
    Lz4(String),
}
