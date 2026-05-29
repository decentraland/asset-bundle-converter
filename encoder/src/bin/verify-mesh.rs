//! Verify build_mesh_value (class 43) against a real Unity 6 glb Mesh.
//!
//! Same strategy as verify-material: read the real Mesh → Value (round-trip
//! gated), extract a UnityMeshObject (only the varying fields; the empty
//! sub-structures are hardcoded in the builder), rebuild, and require the
//! written bytes equal the real object.
//!
//! Usage:
//!   cargo run --bin verify-mesh --no-default-features -- <v49-glb-bundle>

use std::process::ExitCode;

use dcl_asset_bundle_encoder::encode::class_writers::{
    build_mesh_value, MeshAabb, MeshChannel, MeshLodRange, MeshSubMesh, UnityMeshObject,
};
use dcl_asset_bundle_encoder::encode::serialized_file_reader::parse_serialized_file;
use dcl_asset_bundle_encoder::encode::type_tree::{TypeTreeReader, TypeTreeWriter, Value};
use dcl_asset_bundle_encoder::encode::unityfs_writer::parse_bundle;

const MESH_CLASS_ID: i32 = 43;

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().collect();
    if args.len() != 2 {
        eprintln!("usage: verify-mesh <glb-bundle>");
        return ExitCode::from(2);
    }
    match run(&args[1]) {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => {
            eprintln!("FAILED: {e}");
            ExitCode::FAILURE
        }
    }
}

fn run(path: &str) -> Result<(), String> {
    let db = match dcl_asset_bundle_encoder::encode::type_tree_db::load_fixture_with_class(MESH_CLASS_ID) {
        Some(db) => db,
        None => {
            eprintln!("[verify] no Mesh fixture — run scripts/regenerate-fixtures.sh; skipping");
            return Ok(());
        }
    };
    let bytes = std::fs::read(path).map_err(|e| format!("read: {e}"))?;
    let parsed = parse_bundle(&bytes).map_err(|e| format!("UnityFS: {e}"))?;
    let sf_node = parsed.directory.iter().find(|n| !n.path.ends_with(".resS")).ok_or("no SF")?;
    let sf = &parsed.data_payload_uncompressed
        [sf_node.offset as usize..(sf_node.offset + sf_node.size) as usize];
    let ref_obj = extract_first_object_bytes(sf, MESH_CLASS_ID)?;
    eprintln!("[verify] reference Mesh: {} bytes (unity={})", ref_obj.len(), parsed.unity_revision);

    let nodes = db.get(MESH_CLASS_ID).ok_or("class 43 not in fixture")?;
    if parsed.unity_revision != db.unity_version {
        return Err(format!(
            "bundle is {} but fixture is {} — Mesh layout is version-specific; \
             use a reference bundle matching the fixture",
            parsed.unity_revision, db.unity_version
        ));
    }

    let mut reader = TypeTreeReader::new(nodes, ref_obj);
    let v = reader.read_root().map_err(|e| format!("read_root: {e}"))?;

    // Round-trip gate.
    {
        let mut w = TypeTreeWriter::new(nodes);
        w.write_root(&v).map_err(|e| format!("roundtrip write: {e}"))?;
        if w.finish() != ref_obj {
            return Err("round-trip of read value not byte-equal — reader/writer issue".into());
        }
    }

    let mesh = extract_mesh(&v)?;
    eprintln!(
        "[verify] extracted: name={:?} submeshes={} verts={} channels={} idx_buf={}B vert_data={}B lod_levels={}",
        mesh.name, mesh.sub_meshes.len(), mesh.vertex_count, mesh.channels.len(),
        mesh.index_buffer.len(), mesh.vertex_data.len(), mesh.lod_num_levels
    );

    let built = build_mesh_value(&mesh);
    let mut w = TypeTreeWriter::new(nodes);
    w.write_root(&built).map_err(|e| format!("build write: {e}"))?;
    let our = w.finish();
    eprintln!("[verify] our Mesh:       {} bytes", our.len());

    if our == ref_obj {
        eprintln!("[verify] ✓ BYTE-EQUAL ✓");
        Ok(())
    } else {
        let min = our.len().min(ref_obj.len());
        for i in 0..min {
            if our[i] != ref_obj[i] {
                let s = i.saturating_sub(8);
                let e = (i + 16).min(min);
                eprintln!("[verify] first diff at offset {i}: ref={:02x} ours={:02x}", ref_obj[i], our[i]);
                eprintln!("[verify] ref [{s}..{e}]: {:02x?}", &ref_obj[s..e]);
                eprintln!("[verify] ours[{s}..{e}]: {:02x?}", &our[s..e]);
                break;
            }
        }
        if our.len() != ref_obj.len() {
            eprintln!("[verify] length: ref={} ours={}", ref_obj.len(), our.len());
        }
        Err("mismatch".into())
    }
}

fn seq(v: &Value) -> Result<&[Value], String> {
    match v { Value::Seq(s) => Ok(s), o => Err(format!("expected Seq, got {o:?}")) }
}
fn arr(v: &Value) -> Result<&[Value], String> {
    match v { Value::Array(a) => Ok(a), o => Err(format!("expected Array, got {o:?}")) }
}
fn as_string(v: &Value) -> Result<String, String> {
    match v {
        Value::String(s) => Ok(s.clone()),
        Value::Bytes(b) => Ok(String::from_utf8_lossy(b).into_owned()),
        o => Err(format!("expected String, got {o:?}")),
    }
}
fn as_bytes(v: &Value) -> Result<Vec<u8>, String> {
    match v {
        Value::Bytes(b) => Ok(b.clone()),
        Value::String(s) => Ok(s.clone().into_bytes()),
        Value::Array(a) if a.is_empty() => Ok(vec![]),
        o => Err(format!("expected Bytes, got {o:?}")),
    }
}
fn as_u32(v: &Value) -> Result<u32, String> {
    match v { Value::U32(x) => Ok(*x), Value::I32(x) => Ok(*x as u32), o => Err(format!("expected u32, got {o:?}")) }
}
fn as_u64(v: &Value) -> Result<u64, String> {
    match v { Value::U64(x) => Ok(*x), Value::I64(x) => Ok(*x as u64), o => Err(format!("expected u64, got {o:?}")) }
}
fn as_u8(v: &Value) -> Result<u8, String> {
    match v { Value::U8(x) => Ok(*x), Value::Bool(b) => Ok(*b as u8), o => Err(format!("expected u8, got {o:?}")) }
}
fn as_f32(v: &Value) -> Result<f32, String> { Ok(f32::from_bits(as_u32(v)?)) }
fn as_i32(v: &Value) -> Result<i32, String> { Ok(as_u32(v)? as i32) }

fn aabb(v: &Value) -> Result<MeshAabb, String> {
    let s = seq(v)?;
    let c = seq(&s[0])?;
    let e = seq(&s[1])?;
    Ok(MeshAabb {
        center: [as_f32(&c[0])?, as_f32(&c[1])?, as_f32(&c[2])?],
        extent: [as_f32(&e[0])?, as_f32(&e[1])?, as_f32(&e[2])?],
    })
}

fn extract_mesh(v: &Value) -> Result<UnityMeshObject, String> {
    let c = seq(v)?;
    if c.len() != 25 {
        return Err(format!("expected 25 root children, got {}", c.len()));
    }
    let sub_meshes = arr(&c[1])?
        .iter()
        .map(|sm| {
            let s = seq(sm)?;
            Ok(MeshSubMesh {
                first_byte: as_u32(&s[0])?,
                index_count: as_u32(&s[1])?,
                topology: as_i32(&s[2])?,
                base_vertex: as_u32(&s[3])?,
                first_vertex: as_u32(&s[4])?,
                vertex_count: as_u32(&s[5])?,
                local_aabb: aabb(&s[6])?,
            })
        })
        .collect::<Result<Vec<_>, String>>()?;

    // m_VertexData = Seq[ vertex_count, channels(Array<Seq[4 u8]>), data(Bytes) ]
    let vd = seq(&c[14])?;
    let vertex_count = as_u32(&vd[0])?;
    let channels = arr(&vd[1])?
        .iter()
        .map(|ch| {
            let s = seq(ch)?;
            Ok(MeshChannel {
                stream: as_u8(&s[0])?,
                offset: as_u8(&s[1])?,
                format: as_u8(&s[2])?,
                dimension: as_u8(&s[3])?,
            })
        })
        .collect::<Result<Vec<_>, String>>()?;
    let vertex_data = as_bytes(&vd[2])?;

    let stream = seq(&c[23])?;

    // m_MeshLodInfo = Seq[ curve(Seq[slope,bias]), num_levels, submeshes(Array<Seq[ levels(Array<Seq[2]>) ]>) ]
    let lod = seq(&c[24])?;
    let curve = seq(&lod[0])?;
    let lod_sub_meshes = arr(&lod[2])?
        .iter()
        .map(|sm| {
            let levels = arr(&seq(sm)?[0])?;
            levels
                .iter()
                .map(|r| {
                    let s = seq(r)?;
                    Ok(MeshLodRange { index_start: as_u32(&s[0])?, index_count: as_u32(&s[1])? })
                })
                .collect::<Result<Vec<_>, String>>()
        })
        .collect::<Result<Vec<_>, String>>()?;

    Ok(UnityMeshObject {
        name: as_string(&c[0])?,
        sub_meshes,
        root_bone_name_hash: as_u32(&c[5])?,
        mesh_compression: as_u8(&c[8])?,
        is_readable: as_u8(&c[9])?,
        keep_vertices: as_u8(&c[10])?,
        keep_indices: as_u8(&c[11])?,
        index_format: as_i32(&c[12])?,
        index_buffer: as_bytes(&c[13])?,
        vertex_count,
        channels,
        vertex_data,
        local_aabb: aabb(&c[16])?,
        mesh_usage_flags: as_i32(&c[17])?,
        cooking_options: as_i32(&c[18])?,
        mesh_metrics: [as_f32(&c[21])?, as_f32(&c[22])?],
        stream_offset: as_u64(&stream[0])?,
        stream_size: as_u32(&stream[1])?,
        stream_path: as_string(&stream[2])?,
        lod_slope: as_f32(&curve[0])?,
        lod_bias: as_f32(&curve[1])?,
        lod_num_levels: as_i32(&lod[1])?,
        lod_sub_meshes,
    })
}

fn extract_first_object_bytes(sf: &[u8], class_id: i32) -> Result<&[u8], String> {
    let parsed = parse_serialized_file(sf).map_err(|e| format!("parse SF: {e}"))?;
    let type_index = parsed.types.iter().position(|t| t.class_id == class_id).ok_or("class not in SF")?;
    let metadata_size = i64::from_be_bytes(sf[0x10..0x18].try_into().unwrap()) as usize;
    let data_offset = i64::from_be_bytes(sf[0x20..0x28].try_into().unwrap()) as usize;
    let metadata = &sf[48..48 + metadata_size];
    let mut cur = metadata.iter().position(|&b| b == 0).unwrap() + 1;
    cur += 5;
    let tc = i32::from_le_bytes(metadata[cur..cur + 4].try_into().unwrap()) as usize;
    cur += 4;
    for _ in 0..tc {
        cur += 4 + 1 + 2 + 16;
        let nc = u32::from_le_bytes(metadata[cur..cur + 4].try_into().unwrap()) as usize;
        let sb = u32::from_le_bytes(metadata[cur + 4..cur + 8].try_into().unwrap()) as usize;
        let bs = 8 + nc * 32 + sb;
        let dc = u32::from_le_bytes(metadata[cur + bs..cur + bs + 4].try_into().unwrap()) as usize;
        cur += bs + 4 + dc * 4;
    }
    let object_count = i32::from_le_bytes(metadata[cur..cur + 4].try_into().unwrap()) as usize;
    cur += 4;
    for _ in 0..object_count {
        let pad = (4 - (cur % 4)) % 4;
        cur += pad;
        let byte_start = i64::from_le_bytes(metadata[cur + 8..cur + 16].try_into().unwrap()) as usize;
        let bs_le = u32::from_le_bytes(metadata[cur + 16..cur + 20].try_into().unwrap());
        let bs_be = u32::from_be_bytes(metadata[cur + 16..cur + 20].try_into().unwrap());
        let byte_size = if bs_le < 100_000_000 { bs_le as usize } else { bs_be as usize };
        let ti = i32::from_le_bytes(metadata[cur + 20..cur + 24].try_into().unwrap()) as usize;
        cur += 24;
        if ti == type_index {
            return Ok(&sf[data_offset + byte_start..data_offset + byte_start + byte_size]);
        }
    }
    Err(format!("class {class_id} not found"))
}
