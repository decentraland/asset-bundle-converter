//! glTF/glb mesh + scene-graph → Unity conversion.
//!
//! The per-primitive transform rules below were reverse-engineered by
//! converting source glbs and diffing the result, byte-for-byte, against the
//! REAL Unity Mesh objects in the corresponding ab-cdn v49 bundles (Unity
//! 6000.2.6f2). `verify-mesh-from-glb` is the regression harness; across the
//! downloaded v49 corpus this reproduces every production Mesh exactly except
//! for a sub-ULP rounding difference in the bounding-box floats of some
//! collider meshes (≈microns; functionally irrelevant).
//!
//! Unity's rules (DCL converter):
//!   * **One Mesh object per glb primitive.** A glb mesh with N primitives
//!     becomes N separate Mesh objects, all sharing the glb mesh's name.
//!   * **Coordinate handedness:** negate X on position AND normal.
//!   * **UV:** `v → 1 - v`; the UV channel (channel 4, stream 1) only when
//!     the primitive has `TEXCOORD_0`.
//!   * **Indices:** reverse winding per triangle and widen to UInt32.
//!   * **Vertex layout:** two streams — stream 0 = position(12)+normal(12)
//!     interleaved (24B), stream 1 = UV(8B), stream 0 padded to 16 bytes.
//!   * **m_MeshUsageFlags = 0x10** when the mesh's referencing node name ends
//!     `_collider` (DCL collider convention → CPU-readable for physics).
//!
//! Scene graph (`convert_glb_scene`, verified against multi-mesh bundles):
//!   * an "entity root" GameObject named after the glb hash;
//!   * each glb node with a mesh → its primitive 0 attaches to a GameObject
//!     named after the node; primitives 1..N become child GameObjects named
//!     `{meshName}_{i}`;
//!   * collider nodes (`_collider`) get a MeshCollider instead of a
//!     MeshRenderer.

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

/// Parse the glb header into (json, bin-chunk-bytes).
fn parse_glb(glb: &[u8]) -> Result<(J, &[u8]), GltfMeshError> {
    if glb.len() < 20 || &glb[0..4] != b"glTF" {
        return Err(GltfMeshError::NotGlb);
    }
    let jlen = u32::from_le_bytes(glb[12..16].try_into().unwrap()) as usize;
    if 20 + jlen > glb.len() {
        return Err(GltfMeshError::Structure("JSON chunk overruns file".into()));
    }
    let j: J = serde_json::from_slice(&glb[20..20 + jlen]).map_err(|e| GltfMeshError::Json(e.to_string()))?;
    let bin = glb.get(20 + jlen + 8..).unwrap_or(&[]);
    Ok((j, bin))
}

/// Convert glTF `meshes[mesh_idx].primitives[prim_idx]` to a UnityMeshObject.
/// `is_collider` sets `m_MeshUsageFlags`. This is the byte-validated core.
fn convert_primitive(
    j: &J,
    bin: &[u8],
    mesh_idx: usize,
    prim_idx: usize,
    is_collider: bool,
) -> Result<UnityMeshObject, GltfMeshError> {
    let bvs = j["bufferViews"].as_array().ok_or_else(|| GltfMeshError::Structure("no bufferViews".into()))?;
    let accs = j["accessors"].as_array().ok_or_else(|| GltfMeshError::Structure("no accessors".into()))?;
    let mesh = &j["meshes"][mesh_idx];
    let name = mesh["name"].as_str().unwrap_or("").to_string();
    let prim = &mesh["primitives"][prim_idx];

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

    Ok(UnityMeshObject {
        name,
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
    })
}

/// True when any node referencing `mesh_idx` has a `_collider` name.
fn collider_mesh_set(j: &J) -> std::collections::HashSet<usize> {
    let mut set = std::collections::HashSet::new();
    if let Some(nodes) = j["nodes"].as_array() {
        for nd in nodes {
            if let (Some(mi), Some(nm)) = (nd["mesh"].as_u64(), nd["name"].as_str()) {
                if nm.to_lowercase().contains("_collider") {
                    set.insert(mi as usize);
                }
            }
        }
    }
    set
}

/// Convert every (mesh × primitive) in a glb into a Unity `UnityMeshObject`.
/// Flat list (no scene graph) — used by `verify-mesh-from-glb`.
pub fn convert_glb_meshes(glb: &[u8]) -> Result<Vec<ConvertedMesh>, GltfMeshError> {
    let (j, bin) = parse_glb(glb)?;
    let collider = collider_mesh_set(&j);
    let meshes = j["meshes"].as_array().ok_or_else(|| GltfMeshError::Structure("no meshes".into()))?;
    let mut out = Vec::new();
    for (mesh_idx, mesh) in meshes.iter().enumerate() {
        let is_collider = collider.contains(&mesh_idx);
        let name = mesh["name"].as_str().unwrap_or("").to_string();
        let nprim = mesh["primitives"].as_array().map(|a| a.len()).unwrap_or(0);
        for prim_idx in 0..nprim {
            out.push(ConvertedMesh {
                name: name.clone(),
                is_collider,
                mesh: convert_primitive(&j, bin, mesh_idx, prim_idx, is_collider)?,
            });
        }
    }
    Ok(out)
}

// --------------------------------------------------------------------------
// Scene graph
// --------------------------------------------------------------------------

/// One converted glb primitive within a scene node.
#[derive(Debug, Clone)]
pub struct ScenePrimitive {
    pub mesh: UnityMeshObject,
    /// glTF material index for this primitive (for material conversion).
    pub material_index: usize,
    /// Source glТF (mesh, primitive) — dedup key so nodes sharing a glb mesh
    /// reference one Mesh object (production deduplicates; we did not).
    pub mesh_index: usize,
    pub prim_index: usize,
}

/// One glb scene node (a tree node — may carry a mesh, children, or both;
/// mesh-less group/leaf nodes are kept, matching Unity's hierarchy).
#[derive(Debug, Clone)]
pub struct SceneNode {
    pub name: String,
    pub local_position: [f32; 3],
    pub local_rotation: [f32; 4],
    pub local_scale: [f32; 3],
    pub is_collider: bool,
    /// Empty for mesh-less nodes; one entry per glTF primitive otherwise.
    pub primitives: Vec<ScenePrimitive>,
    pub children: Vec<SceneNode>,
}

/// The converted scene graph for one glb — the glТF scene-root nodes as a
/// tree (each node may have children).
#[derive(Debug, Clone)]
pub struct GlbScene {
    pub roots: Vec<SceneNode>,
    /// glTF animation names → one legacy AnimationClip each, plus an
    /// Animation component on the root GameObject (structural pass; curves
    /// are not converted yet — playback is Explorer-gated).
    pub animation_names: Vec<String>,
}

/// Default node TRS (identity).
fn node_trs(nd: &J) -> ([f32; 3], [f32; 4], [f32; 3]) {
    let v3 = |key: &str, def: [f32; 3]| -> [f32; 3] {
        nd[key].as_array().map(|a| [
            a[0].as_f64().unwrap_or(def[0] as f64) as f32,
            a[1].as_f64().unwrap_or(def[1] as f64) as f32,
            a[2].as_f64().unwrap_or(def[2] as f64) as f32,
        ]).unwrap_or(def)
    };
    let rot = nd["rotation"].as_array().map(|a| [
        a[0].as_f64().unwrap_or(0.0) as f32,
        a[1].as_f64().unwrap_or(0.0) as f32,
        a[2].as_f64().unwrap_or(0.0) as f32,
        a[3].as_f64().unwrap_or(1.0) as f32,
    ]).unwrap_or([0.0, 0.0, 0.0, 1.0]);
    let t = v3("translation", [0.0; 3]);
    let s = v3("scale", [1.0, 1.0, 1.0]);
    // glTF (right-handed) → Unity (left-handed): the SAME negate-X handedness
    // flip applied to vertices applies to node transforms. Verified by
    // deep-diffing Transform values against production:
    //   position → (-x, y, z) ; rotation quaternion → (x, -y, -z, w).
    // Scale is unchanged. (Without this, objects render mislocated/rotated.)
    let position = [-t[0], t[1], t[2]];
    let rotation = [rot[0], -rot[1], -rot[2], rot[3]];
    (position, rotation, s)
}

/// Recursively convert glТF node `node_idx` (and its children) into a
/// `SceneNode`. Mesh-less nodes get empty `primitives` but are still kept
/// (Unity emits a GameObject for every node).
fn build_scene_node(j: &J, bin: &[u8], nodes: &[J], node_idx: usize) -> Result<SceneNode, GltfMeshError> {
    let nd = &nodes[node_idx];
    let name = nd["name"].as_str().unwrap_or("").to_string();
    // DCL collider convention (Utils.cs:634): case-insensitive substring, not
    // a suffix — matches `Model_Collider`, `corner_01_collider.001` (Blender
    // numeric suffix), `Glass_Walls_colliders` (plural).
    let is_collider = name.to_lowercase().contains("_collider");
    let (tp, tr, ts) = node_trs(nd);

    let mut primitives = Vec::new();
    if let Some(mesh_idx) = nd["mesh"].as_u64().map(|x| x as usize) {
        let nprim = j["meshes"][mesh_idx]["primitives"].as_array().map(|a| a.len()).unwrap_or(0);
        for prim_idx in 0..nprim {
            let mesh = convert_primitive(j, bin, mesh_idx, prim_idx, is_collider)?;
            let material_index = j["meshes"][mesh_idx]["primitives"][prim_idx]["material"].as_u64().unwrap_or(0) as usize;
            primitives.push(ScenePrimitive { mesh, material_index, mesh_index: mesh_idx, prim_index: prim_idx });
        }
    }

    let mut children = Vec::new();
    if let Some(kids) = nd["children"].as_array() {
        for c in kids {
            if let Some(ci) = c.as_u64() {
                let ci = ci as usize;
                if ci < nodes.len() {
                    children.push(build_scene_node(j, bin, nodes, ci)?);
                }
            }
        }
    }

    Ok(SceneNode {
        name,
        local_position: tp,
        local_rotation: tr,
        local_scale: ts,
        is_collider,
        primitives,
        children,
    })
}

/// Walk a glb's node tree from the scene roots, preserving the full
/// hierarchy (parent groups + leaves, mesh-less or not). The scene roots are
/// `scenes[scene].nodes`; if there's no `scenes` array, roots are the nodes
/// not referenced as anyone's child.
pub fn convert_glb_scene(glb: &[u8]) -> Result<GlbScene, GltfMeshError> {
    let (j, bin) = parse_glb(glb)?;
    let nodes = j["nodes"].as_array().cloned().unwrap_or_default();

    let root_indices: Vec<usize> = if let Some(scenes) = j["scenes"].as_array() {
        let scene_idx = j["scene"].as_u64().unwrap_or(0) as usize;
        scenes
            .get(scene_idx)
            .and_then(|s| s["nodes"].as_array())
            .map(|a| a.iter().filter_map(|n| n.as_u64().map(|x| x as usize)).collect())
            .unwrap_or_default()
    } else {
        // No scenes: roots = nodes not referenced as a child of any node.
        let mut is_child = vec![false; nodes.len()];
        for nd in &nodes {
            if let Some(kids) = nd["children"].as_array() {
                for c in kids {
                    if let Some(ci) = c.as_u64() {
                        if (ci as usize) < is_child.len() {
                            is_child[ci as usize] = true;
                        }
                    }
                }
            }
        }
        (0..nodes.len()).filter(|&i| !is_child[i]).collect()
    };

    let mut roots = Vec::with_capacity(root_indices.len());
    for ri in root_indices {
        if ri < nodes.len() {
            roots.push(build_scene_node(&j, bin, &nodes, ri)?);
        }
    }

    let animation_names = j["animations"]
        .as_array()
        .map(|arr| {
            arr.iter()
                .enumerate()
                .map(|(i, a)| a["name"].as_str().map(|s| s.to_string()).unwrap_or_else(|| format!("anim_{i}")))
                .collect()
        })
        .unwrap_or_default();

    Ok(GlbScene { roots, animation_names })
}

impl GlbScene {
    /// Total primitive count across the whole node tree.
    pub fn total_primitives(&self) -> usize {
        fn count(n: &SceneNode) -> usize {
            n.primitives.len() + n.children.iter().map(count).sum::<usize>()
        }
        self.roots.iter().map(count).sum()
    }
}
