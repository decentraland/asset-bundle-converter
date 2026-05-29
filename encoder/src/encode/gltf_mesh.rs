//! glTF/glb mesh → Unity `UnityMeshObject` conversion.
//!
//! The transform rules below were reverse-engineered by converting source
//! glbs and diffing the result, byte-for-byte, against the REAL Unity Mesh
//! objects in the corresponding ab-cdn v49 bundles (Unity 6000.2.6f2).
//! `verify-mesh-from-glb` is the regression harness; across the downloaded
//! v49 corpus this reproduces every production Mesh exactly except for a
//! sub-ULP rounding difference in the bounding-box floats of some collider
//! meshes (≈microns; functionally irrelevant).
//!
//! Unity's rules (DCL converter):
//!   * **One Mesh object per glb primitive.** A glb mesh with N primitives
//!     becomes N separate Mesh objects, all sharing the glb mesh's name,
//!     each with a single submesh.
//!   * **Coordinate handedness:** negate X on position AND normal
//!     (glTF right-handed → Unity left-handed).
//!   * **UV:** `v → 1 - v`; the UV channel (channel 4, stream 1) is emitted
//!     only when the primitive has `TEXCOORD_0`.
//!   * **Indices:** reverse winding per triangle (`a,b,c → a,c,b`, because
//!     negating X flips facing) and widen to UInt32 (m_IndexFormat=1).
//!   * **Vertex layout:** two streams — stream 0 = position(12B)+normal(12B)
//!     interleaved per vertex (24B), stream 1 = UV(8B). Stream 0 is padded
//!     to a 16-byte boundary before stream 1.
//!   * **m_MeshUsageFlags = 0x10** when the mesh's referencing node name
//!     ends with `_collider` (DCL collider convention → CPU-readable for
//!     physics), else 0.

use serde_json::Value as J;

use crate::encode::class_writers::{
    MeshAabb, MeshChannel, MeshLodRange, MeshSubMesh, UnityMeshObject,
};

/// 0x10 — set on meshes used as physics colliders.
const MESH_USAGE_COLLIDER: i32 = 0x10;

#[derive(Debug, thiserror::Error)]
pub enum GltfMeshError {
    #[error("not a glb (bad magic)")]
    NotGlb,
    #[error("malformed glTF JSON: {0}")]
    Json(String),
    #[error("glTF structure: {0}")]
    Structure(String),
}

/// One converted Unity mesh, ready for `build_mesh_value` + assembly.
#[derive(Debug, Clone)]
pub struct ConvertedMesh {
    /// glb mesh name (shared across a multi-primitive mesh's objects).
    pub name: String,
    /// True when the referencing node is a `_collider` node.
    pub is_collider: bool,
    pub mesh: UnityMeshObject,
}

/// Convert every (mesh × primitive) in a glb into a Unity `UnityMeshObject`.
pub fn convert_glb_meshes(glb: &[u8]) -> Result<Vec<ConvertedMesh>, GltfMeshError> {
    if glb.len() < 20 || &glb[0..4] != b"glTF" {
        return Err(GltfMeshError::NotGlb);
    }
    let jlen = u32::from_le_bytes(glb[12..16].try_into().unwrap()) as usize;
    if 20 + jlen > glb.len() {
        return Err(GltfMeshError::Structure("JSON chunk overruns file".into()));
    }
    let j: J = serde_json::from_slice(&glb[20..20 + jlen]).map_err(|e| GltfMeshError::Json(e.to_string()))?;
    // BIN chunk follows the JSON chunk: 8-byte chunk header (length + type).
    let bin = glb.get(20 + jlen + 8..).unwrap_or(&[]);

    let bvs = j["bufferViews"].as_array().ok_or_else(|| GltfMeshError::Structure("no bufferViews".into()))?;
    let accs = j["accessors"].as_array().ok_or_else(|| GltfMeshError::Structure("no accessors".into()))?;
    let meshes = j["meshes"].as_array().ok_or_else(|| GltfMeshError::Structure("no meshes".into()))?;

    let bvbytes = |bvi: usize| -> &[u8] {
        let b = &bvs[bvi];
        let o = b["byteOffset"].as_u64().unwrap_or(0) as usize;
        let l = b["byteLength"].as_u64().unwrap_or(0) as usize;
        bin.get(o..o + l).unwrap_or(&[])
    };
    let acc_bytes = |ai: usize| -> (&[u8], usize) {
        let a = &accs[ai];
        let bv = a["bufferView"].as_u64().unwrap() as usize;
        let bo = a["byteOffset"].as_u64().unwrap_or(0) as usize;
        (&bvbytes(bv)[bo..], a["count"].as_u64().unwrap() as usize)
    };
    let getf = |buf: &[u8], i: usize| f32::from_le_bytes(buf[i * 4..i * 4 + 4].try_into().unwrap());

    // Collider meshes: any node whose name ends "_collider".
    let mut collider_mesh = std::collections::HashSet::new();
    if let Some(nodes) = j["nodes"].as_array() {
        for nd in nodes {
            if let (Some(mi), Some(nm)) = (nd["mesh"].as_u64(), nd["name"].as_str()) {
                if nm.ends_with("_collider") {
                    collider_mesh.insert(mi as usize);
                }
            }
        }
    }

    let mut out = Vec::new();
    for (mesh_idx, mesh) in meshes.iter().enumerate() {
        let name = mesh["name"].as_str().unwrap_or("").to_string();
        let is_collider = collider_mesh.contains(&mesh_idx);
        let prims = mesh["primitives"].as_array().ok_or_else(|| GltfMeshError::Structure("no primitives".into()))?;
        for prim in prims {
            let at = &prim["attributes"];
            let pos_ai = at["POSITION"].as_u64().ok_or_else(|| GltfMeshError::Structure("primitive has no POSITION".into()))? as usize;
            let (pos, vcount) = acc_bytes(pos_ai);
            let nrm = at["NORMAL"].as_u64().map(|ai| acc_bytes(ai as usize).0);
            let uv = at["TEXCOORD_0"].as_u64().map(|ai| acc_bytes(ai as usize).0);
            let has_uv = uv.is_some();

            let mut s0 = Vec::with_capacity(vcount * 24);
            let mut s1 = Vec::with_capacity(vcount * 8);
            let mut minp = [f32::MAX; 3];
            let mut maxp = [f32::MIN; 3];
            for v in 0..vcount {
                // negate X on position (handedness flip)
                let px = -getf(pos, v * 3);
                let py = getf(pos, v * 3 + 1);
                let pz = getf(pos, v * 3 + 2);
                for (k, c) in [px, py, pz].iter().enumerate() {
                    minp[k] = minp[k].min(*c);
                    maxp[k] = maxp[k].max(*c);
                }
                s0.extend_from_slice(&px.to_le_bytes());
                s0.extend_from_slice(&py.to_le_bytes());
                s0.extend_from_slice(&pz.to_le_bytes());
                if let Some(nb) = nrm {
                    // negate X on normal too
                    s0.extend_from_slice(&(-getf(nb, v * 3)).to_le_bytes());
                    s0.extend_from_slice(&getf(nb, v * 3 + 1).to_le_bytes());
                    s0.extend_from_slice(&getf(nb, v * 3 + 2).to_le_bytes());
                } else {
                    s0.extend_from_slice(&[0u8; 12]);
                }
                if let Some(ub) = uv {
                    s1.extend_from_slice(&getf(ub, v * 2).to_le_bytes());
                    s1.extend_from_slice(&(1.0 - getf(ub, v * 2 + 1)).to_le_bytes());
                }
            }
            let mut vertex_data = s0;
            if has_uv {
                while vertex_data.len() % 16 != 0 {
                    vertex_data.push(0);
                }
                vertex_data.extend_from_slice(&s1);
            }

            // indices: widen to u32, reverse winding per triangle.
            let idx_ai = prim["indices"].as_u64().ok_or_else(|| GltfMeshError::Structure("primitive has no indices".into()))? as usize;
            let (ib, icount) = acc_bytes(idx_ai);
            let icomp = accs[idx_ai]["componentType"].as_u64().unwrap();
            let rd = |i: usize| -> u32 {
                match icomp {
                    5121 => ib[i] as u32,
                    5123 => u16::from_le_bytes(ib[i * 2..i * 2 + 2].try_into().unwrap()) as u32,
                    5125 => u32::from_le_bytes(ib[i * 4..i * 4 + 4].try_into().unwrap()),
                    _ => 0,
                }
            };
            let mut index_buffer = Vec::with_capacity(icount * 4);
            let mut t = 0;
            while t + 3 <= icount {
                let (a, b, c) = (rd(t), rd(t + 1), rd(t + 2));
                for x in [a, c, b] {
                    index_buffer.extend_from_slice(&x.to_le_bytes());
                }
                t += 3;
            }

            let aabb = MeshAabb {
                center: [(minp[0] + maxp[0]) / 2.0, (minp[1] + maxp[1]) / 2.0, (minp[2] + maxp[2]) / 2.0],
                extent: [(maxp[0] - minp[0]) / 2.0, (maxp[1] - minp[1]) / 2.0, (maxp[2] - minp[2]) / 2.0],
            };

            let mut channels = vec![MeshChannel::default(); 14];
            channels[0] = MeshChannel { stream: 0, offset: 0, format: 0, dimension: 3 };
            channels[1] = MeshChannel { stream: 0, offset: 12, format: 0, dimension: 3 };
            if has_uv {
                channels[4] = MeshChannel { stream: 1, offset: 0, format: 0, dimension: 2 };
            }

            out.push(ConvertedMesh {
                name: name.clone(),
                is_collider,
                mesh: UnityMeshObject {
                    name: name.clone(),
                    sub_meshes: vec![MeshSubMesh {
                        first_byte: 0,
                        index_count: icount as u32,
                        topology: 0,
                        base_vertex: 0,
                        first_vertex: 0,
                        vertex_count: vcount as u32,
                        local_aabb: aabb.clone(),
                    }],
                    root_bone_name_hash: 0,
                    mesh_compression: 0,
                    is_readable: 1,
                    keep_vertices: 0,
                    keep_indices: 0,
                    index_format: 1,
                    index_buffer,
                    vertex_count: vcount as u32,
                    channels,
                    vertex_data,
                    local_aabb: aabb,
                    mesh_usage_flags: if is_collider { MESH_USAGE_COLLIDER } else { 0 },
                    cooking_options: 30,
                    mesh_metrics: [1.0, 1.0],
                    stream_offset: 0,
                    stream_size: 0,
                    stream_path: String::new(),
                    lod_slope: 0.0,
                    lod_bias: 0.0,
                    lod_num_levels: 1,
                    lod_sub_meshes: vec![vec![MeshLodRange { index_start: 0, index_count: 0 }]],
                },
            });
        }
    }
    Ok(out)
}
