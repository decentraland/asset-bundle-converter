//! Verify the MeshRenderer writer (class 23) against a Unity 6 bundle.
//!
//! Field layout derived from `dump-fields` against the v49 (Unity
//! 6000.2.6f2) bundle. Unity 6 added 5 fields vs 2022.3. Uses the
//! matching 6000.2.6f2 TypeTree fixture — using the 2022.3 fixture
//! against a Unity 6 bundle is exactly what produced the earlier
//! "quirk" (a 12-byte cascade misalignment).

use std::process::ExitCode;

use dcl_asset_bundle_encoder::encode::class_writers::{
    build_mesh_renderer_value, PPtr, UnityMeshRenderer,
};
use dcl_asset_bundle_encoder::encode::serialized_file_reader::parse_serialized_file;
use dcl_asset_bundle_encoder::encode::type_tree::TypeTreeWriter;
use dcl_asset_bundle_encoder::encode::type_tree_db::TypeTreeDb;
use dcl_asset_bundle_encoder::encode::unityfs_writer::parse_bundle;

const CLASS_ID: i32 = 23;

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().collect();
    if args.len() != 2 {
        eprintln!("usage: verify-mesh-renderer <bundle>");
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
    let db = match load_db_with_class(CLASS_ID) {
        Some(db) => db,
        None => {
            eprintln!("[verify] no TypeTree fixture — run scripts/regenerate-fixtures.sh; skipping");
            return Ok(());
        }
    };
    let bytes = std::fs::read(path).map_err(|e| format!("{e}"))?;
    let parsed = parse_bundle(&bytes).map_err(|e| format!("{e}"))?;
    let sf_node = parsed.directory.iter().find(|n| !n.path.ends_with(".resS")).ok_or("no SF")?;
    let sf = &parsed.data_payload_uncompressed[sf_node.offset as usize..(sf_node.offset + sf_node.size) as usize];
    let ref_obj = extract_first_object_bytes(sf, CLASS_ID)?;
    eprintln!("[verify] reference MeshRenderer: {} bytes", ref_obj.len());

    let mut p = Parser::new(ref_obj);
    let game_object = p.read_pptr();
    let enabled = p.read_u8();
    let cast_shadows = p.read_u8();
    let receive_shadows = p.read_u8();
    let dynamic_occludee = p.read_u8();
    let static_shadow_caster = p.read_u8();
    let motion_vectors = p.read_u8();
    let light_probe_usage = p.read_u8();
    let reflection_probe_usage = p.read_u8();
    let ray_tracing_mode = p.read_u8();
    let ray_trace_procedural = p.read_u8();
    let ray_tracing_accel_struct_build_flags_override = p.read_u8();
    let ray_tracing_accel_struct_build_flags = p.read_u8();
    let small_mesh_culling = p.read_u8();
    p.align(4); // ALIGN after m_SmallMeshCulling (@25 → @28)
    let force_mesh_lod = p.read_i16();
    p.align(4); // ALIGN before m_MeshLodSelectionBias f32 (@30 → @32)
    let mesh_lod_selection_bias = p.read_f32();
    let rendering_layer_mask = p.read_u32();
    let renderer_priority = p.read_i32();
    let lightmap_index = p.read_u16();
    let lightmap_index_dynamic = p.read_u16();
    let lightmap_tiling_offset = [p.read_f32(), p.read_f32(), p.read_f32(), p.read_f32()];
    let lightmap_tiling_offset_dynamic = [p.read_f32(), p.read_f32(), p.read_f32(), p.read_f32()];
    let mat_count = p.read_u32() as usize;
    let mut materials = Vec::with_capacity(mat_count);
    for _ in 0..mat_count {
        materials.push(p.read_pptr());
    }
    let static_batch_first_submesh = p.read_u16();
    let static_batch_submesh_count = p.read_u16();
    let static_batch_root = p.read_pptr();
    let probe_anchor = p.read_pptr();
    let light_probe_volume_override = p.read_pptr();
    let sorting_layer_id = p.read_i32();
    let sorting_layer = p.read_i16();
    let sorting_order = p.read_i16();
    let additional_vertex_streams = p.read_pptr();
    let enlighten_vertex_stream = p.read_pptr();
    eprintln!("[verify] parsed {} of {} bytes, materials={mat_count}", p.pos, ref_obj.len());

    let mr = UnityMeshRenderer {
        game_object,
        enabled,
        cast_shadows,
        receive_shadows,
        dynamic_occludee,
        static_shadow_caster,
        motion_vectors,
        light_probe_usage,
        reflection_probe_usage,
        ray_tracing_mode,
        ray_trace_procedural,
        ray_tracing_accel_struct_build_flags_override,
        ray_tracing_accel_struct_build_flags,
        small_mesh_culling,
        force_mesh_lod,
        mesh_lod_selection_bias,
        rendering_layer_mask,
        renderer_priority,
        lightmap_index,
        lightmap_index_dynamic,
        lightmap_tiling_offset,
        lightmap_tiling_offset_dynamic,
        materials,
        static_batch_first_submesh,
        static_batch_submesh_count,
        static_batch_root,
        probe_anchor,
        light_probe_volume_override,
        sorting_layer_id,
        sorting_layer,
        sorting_order,
        additional_vertex_streams,
        enlighten_vertex_stream,
    };

    let value = build_mesh_renderer_value(&mr);
    let nodes = db.get(CLASS_ID).ok_or("class 23 not in fixture")?;
    let mut writer = TypeTreeWriter::new(nodes);
    writer.write_root(&value).map_err(|e| format!("write: {e}"))?;
    let our_bytes = writer.finish();
    eprintln!("[verify] our MeshRenderer:       {} bytes", our_bytes.len());

    if our_bytes == ref_obj {
        eprintln!("[verify] ✓ BYTE-EQUAL ✓");
        Ok(())
    } else {
        let min = our_bytes.len().min(ref_obj.len());
        for i in 0..min {
            if our_bytes[i] != ref_obj[i] {
                eprintln!("[verify] first diff at offset {i}: ref={:02x} ours={:02x}", ref_obj[i], our_bytes[i]);
                let s = i.saturating_sub(16);
                let e = (i + 32).min(min);
                eprintln!("[verify] ref [{s}..{e}]: {:02x?}", &ref_obj[s..e]);
                eprintln!("[verify] ours[{s}..{e}]: {:02x?}", &our_bytes[s..e]);
                break;
            }
        }
        if our_bytes.len() != ref_obj.len() {
            eprintln!("[verify] length: ref={} ours={}", ref_obj.len(), our_bytes.len());
        }
        Err("mismatch".into())
    }
}

struct Parser<'a> {
    buf: &'a [u8],
    pos: usize,
}

impl<'a> Parser<'a> {
    fn new(buf: &'a [u8]) -> Self { Self { buf, pos: 0 } }
    fn read_u8(&mut self) -> u8 { let v = self.buf[self.pos]; self.pos += 1; v }
    fn read_i16(&mut self) -> i16 { let v = i16::from_le_bytes(self.buf[self.pos..self.pos+2].try_into().unwrap()); self.pos += 2; v }
    fn read_u16(&mut self) -> u16 { let v = u16::from_le_bytes(self.buf[self.pos..self.pos+2].try_into().unwrap()); self.pos += 2; v }
    fn read_u32(&mut self) -> u32 { let v = u32::from_le_bytes(self.buf[self.pos..self.pos+4].try_into().unwrap()); self.pos += 4; v }
    fn read_i32(&mut self) -> i32 { self.read_u32() as i32 }
    fn read_i64(&mut self) -> i64 { let v = i64::from_le_bytes(self.buf[self.pos..self.pos+8].try_into().unwrap()); self.pos += 8; v }
    fn read_f32(&mut self) -> f32 { let v = f32::from_le_bytes(self.buf[self.pos..self.pos+4].try_into().unwrap()); self.pos += 4; v }
    fn read_pptr(&mut self) -> PPtr { PPtr { file_id: self.read_i32(), path_id: self.read_i64() } }
    fn align(&mut self, n: usize) { let pad = (n - (self.pos % n)) % n; self.pos += pad; }
}

fn load_db_with_class(class_id: i32) -> Option<TypeTreeDb> {
    dcl_asset_bundle_encoder::encode::type_tree_db::load_fixture_with_class(class_id)
}

fn extract_first_object_bytes(sf: &[u8], class_id: i32) -> Result<&[u8], String> {
    let parsed = parse_serialized_file(sf).map_err(|e| format!("{e}"))?;
    let type_index = parsed.types.iter().position(|t| t.class_id == class_id).ok_or("not in SF")?;
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
