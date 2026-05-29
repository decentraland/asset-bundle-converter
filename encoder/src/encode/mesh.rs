//! Mesh encoding — glTF primitives → Unity Mesh asset binary.
//!
//! ⚠️ STATUS — interface settled, binary writer TODO. Inventing the exact
//! Unity 2021.3 Mesh serialisation layout without reference fixtures
//! produces bundles the Explorer can't load. The unblock is the phase-0
//! spike: pick one converted glb bundle from `ab-cdn`, decompile its Mesh
//! object with AssetRipper / UnityPy, replicate the byte layout, then
//! verify by re-encoding the same glb input and diffing.

use serde::Serialize;

/// Unity vertex channel layout, in the order Unity's `VertexData`
/// serialiser writes them. Channel set + interleaving depends on which
/// attributes the source mesh provides — Unity stores channels as a
/// bitmask + per-channel stride table.
///
/// glTF source attribute → Unity channel:
///   POSITION  → 0 (Position)
///   NORMAL    → 1 (Normal)
///   TANGENT   → 2 (Tangent)
///   COLOR_0   → 3 (Color)
///   TEXCOORD_0 → 4 (UV0)
///   TEXCOORD_1 → 5 (UV1)
///   TEXCOORD_2..3 → 6..7 (UV2..3, rarely used)
///   JOINTS_0  → 12 (BlendIndices)
///   WEIGHTS_0 → 13 (BlendWeight)
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum VertexChannel {
    Position,
    Normal,
    Tangent,
    Color,
    UV0,
    UV1,
    UV2,
    UV3,
    BlendIndices,
    BlendWeight,
}

#[derive(Debug, Clone, Serialize)]
pub struct VertexAttributeDescriptor {
    pub channel: VertexChannel,
    /// Unity ClassID for the storage type, e.g. 0=Float, 9=UInt8.
    pub format: VertexFormat,
    /// Number of components per vertex (1..=4).
    pub dimension: u8,
    /// Sub-mesh index this channel maps to. For glTF→Unity we always
    /// emit a single shared vertex buffer, so this is 0.
    pub stream: u8,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum VertexFormat {
    Float32,
    Float16,
    UNorm8,
    UInt8,
    UInt16,
    SInt16,
}

#[derive(Debug, Clone, Serialize)]
pub struct SubMeshDescriptor {
    /// First index into the index buffer for this submesh.
    pub index_start: u32,
    pub index_count: u32,
    /// glTF primitive topology — Unity uses GL_TRIANGLES (0x0004) etc.
    pub topology: MeshTopology,
    /// Bounding box for the submesh; computed from the vertex span.
    pub bounds: AABB,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum MeshTopology {
    Triangles,
    TriangleStrip,
    Lines,
    LineStrip,
    Points,
}

#[derive(Debug, Clone, Serialize)]
pub struct AABB {
    pub center: [f32; 3],
    pub extent: [f32; 3],
}

/// In-memory Unity Mesh asset, ready for serialisation. Field ordering
/// here matches the Unity TypeTree layout (positions before normals,
/// vertex data before index data, etc.).
#[derive(Debug, Clone, Serialize)]
pub struct UnityMesh {
    pub name: String,
    pub vertex_count: u32,
    pub vertex_layout: Vec<VertexAttributeDescriptor>,
    /// Interleaved vertex bytes, in `vertex_layout` order.
    pub vertex_data: Vec<u8>,
    /// Index buffer — bit width matches `vertex_count` (16-bit when
    /// vertex_count ≤ 65535, 32-bit otherwise).
    pub index_buffer: Vec<u8>,
    pub submeshes: Vec<SubMeshDescriptor>,
    pub bounds: AABB,
}

/// Convert a parsed glTF primitive set into a UnityMesh ready for
/// serialisation. Pure CPU work, no I/O.
///
/// Inputs:
///   * `gltf_mesh` — the parsed glTF mesh primitive(s) for one logical
///     mesh asset. A glTF mesh with N primitives becomes one UnityMesh
///     with N submeshes.
///   * `buffer_data` — the resolved buffer bytes for any `bufferView`s
///     referenced by primitive accessors. Resolution against the entity
///     contentMap happens upstream in `scene_encoder.rs`.
pub fn convert_gltf_to_unity_mesh(
    _gltf_mesh_name: &str,
    _primitives: &[GltfPrimitive],
    _buffer_data: &[u8],
) -> Result<UnityMesh, MeshConversionError> {
    // ---------- TODO (phase 1: real conversion) -------------------------
    // 1. For each glTF primitive, read its accessor table to find vertex
    //    spans and index spans. glTF stores attributes as `accessor` →
    //    `bufferView` → `buffer` chains.
    // 2. Interleave vertex attributes into Unity's channel-packed layout
    //    described by `VertexAttributeDescriptor` above. Endianness:
    //    Unity stores floats little-endian on every supported platform;
    //    `f32::to_le_bytes` matches.
    // 3. Build the index buffer:
    //    - vertex_count ≤ 65535 → 16-bit indices
    //    - otherwise → 32-bit
    //    Note: glTF allows per-primitive index type (5121 u8, 5123 u16,
    //    5125 u32). Widen to the bit width chosen for the merged mesh.
    // 4. Compute AABB across all primitives' POSITION accessors.
    // 5. Generate per-submesh AABBs (range over their own POSITION span).
    //
    // Reference fixture: decompile a converted Unity bundle for a glb of
    // known shape (e.g. a simple cube), extract its Mesh object via
    // UnityPy, and check `to_dict()` against the UnityMesh produced
    // here.
    // --------------------------------------------------------------------

    Err(MeshConversionError::NotImplemented)
}

/// Convert a UnityMesh into its serialised binary form using the loaded
/// TypeTree. Returns the bytes that will live inside the UnityFS file's
/// serialised-file payload (one object record).
///
/// The TypeTree-driven serialisation is the load-bearing piece — every
/// field above is keyed by name in the TypeTree dump and the writer must
/// emit them in TypeTree order, with TypeTree padding rules (4-byte
/// align after every field marked `kAlignBytesFlag`).
pub fn serialize_unity_mesh(_mesh: &UnityMesh, _type_trees: &crate::types::ShaderManifest) -> Result<Vec<u8>, MeshConversionError> {
    // ---------- TODO (phase 1: TypeTree-driven Mesh writer) -------------
    // Inputs:
    //   * UnityMesh struct above
    //   * TypeTreeDb for the active Unity version (carried by SceneEncoderInner)
    //
    // Output:
    //   Vec<u8> ready to be referenced from the SerializedFile object table.
    //
    // The TypeTree for `class Mesh` at Unity 2021.3.20f1 enumerates fields
    // in order: `m_Name`, `m_SubMeshes` (array), `m_Shapes`,
    // `m_BindPose` (array), `m_BoneNameHashes` (array), `m_RootBoneNameHash`,
    // `m_BonesAABB`, `m_VariableBoneCountWeights`, `m_MeshCompression`,
    // `m_IsReadable`, `m_KeepVertices`, `m_KeepIndices`, `m_IndexFormat`,
    // `m_IndexBuffer` (array<u8>), `m_VertexData` (struct), `m_CompressedMesh`,
    // `m_LocalAABB`, `m_MeshUsageFlags`, `m_BakedConvexCollisionMesh`,
    // `m_BakedTriangleCollisionMesh`, `m_MeshMetrics`, `m_StreamData`.
    // (Exact ordering from a TypeTreeGenerator dump.)
    //
    // Each field's writer reads the TypeTree node's type + flags:
    //   - kAlignBytesFlag (0x4000): pad to 4-byte alignment after write
    //   - Array types: u32 length prefix, then element bytes
    //   - struct/class: recursive write of children in TypeTree order
    //
    // Caveat: `_type_trees` is currently typed as ShaderManifest because
    // the real TypeTreeDb type doesn't exist yet — fix the signature
    // when the dumper produces the actual schema artefact.
    // --------------------------------------------------------------------

    Err(MeshConversionError::NotImplemented)
}

/// Minimal in-memory representation of a glTF primitive — accessor
/// indices and topology only. Filled by the glTF parser; consumed by
/// `convert_gltf_to_unity_mesh`.
#[derive(Debug, Clone)]
pub struct GltfPrimitive {
    pub position_accessor: u32,
    pub normal_accessor: Option<u32>,
    pub tangent_accessor: Option<u32>,
    pub color_accessor: Option<u32>,
    pub uv0_accessor: Option<u32>,
    pub uv1_accessor: Option<u32>,
    pub joints_accessor: Option<u32>,
    pub weights_accessor: Option<u32>,
    pub indices_accessor: Option<u32>,
    pub topology: MeshTopology,
    pub material: Option<u32>,
}

#[derive(Debug, thiserror::Error)]
pub enum MeshConversionError {
    #[error("mesh encoder not implemented")]
    NotImplemented,
    #[error("invalid accessor reference: {0}")]
    InvalidAccessor(String),
    #[error("unsupported vertex format: {0}")]
    UnsupportedFormat(String),
}
