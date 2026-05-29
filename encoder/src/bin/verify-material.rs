//! Verify the Material writer (class 21, DCL/Scene) against a real glb bundle.
//!
//! Strategy (build_material_value is the code under test):
//!   1. Extract the real Material object's bytes.
//!   2. Parse them with TypeTreeReader → Value_ref. (write(Value_ref)==bytes
//!      is already proven by verify-roundtrip, used here only as a sanity gate
//!      and to source realistic field values.)
//!   3. Extract a UnityMaterial from Value_ref.
//!   4. build_material_value(mat) → Value_built; write it.
//!   5. Require the rebuilt bytes equal the real Material bytes.
//!
//! The TypeTreeWriter is independent ground truth, so a wrong field in the
//! builder shows up as a byte diff.
//!
//! Usage:
//!   cargo run --bin verify-material --no-default-features -- <glb-bundle>

use std::process::ExitCode;

use dcl_asset_bundle_encoder::encode::class_writers::{
    build_material_value, PPtr, TexEnv, UnityMaterial,
};
use dcl_asset_bundle_encoder::encode::serialized_file_reader::parse_serialized_file;
use dcl_asset_bundle_encoder::encode::type_tree::{TypeTreeReader, TypeTreeWriter, Value};
use dcl_asset_bundle_encoder::encode::unityfs_writer::parse_bundle;

const MATERIAL_CLASS_ID: i32 = 21;

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().collect();
    if args.len() != 2 {
        eprintln!("usage: verify-material <glb-bundle>");
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
    let db = match dcl_asset_bundle_encoder::encode::type_tree_db::load_fixture_with_class(
        MATERIAL_CLASS_ID,
    ) {
        Some(db) => db,
        None => {
            eprintln!("[verify] no Material fixture — run scripts/regenerate-fixtures.sh; skipping");
            return Ok(());
        }
    };

    let bytes = std::fs::read(path).map_err(|e| format!("read: {e}"))?;
    let parsed = parse_bundle(&bytes).map_err(|e| format!("UnityFS: {e}"))?;
    let sf_node = parsed.directory.iter().find(|n| !n.path.ends_with(".resS")).ok_or("no SF")?;
    let sf = &parsed.data_payload_uncompressed
        [sf_node.offset as usize..(sf_node.offset + sf_node.size) as usize];
    let ref_obj = extract_first_object_bytes(sf, MATERIAL_CLASS_ID)?;
    eprintln!("[verify] reference Material: {} bytes", ref_obj.len());

    let nodes = db.get(MATERIAL_CLASS_ID).ok_or("class 21 not in fixture")?;

    // 2. Read the real bytes → Value_ref.
    let mut reader = TypeTreeReader::new(nodes, ref_obj);
    let value_ref = reader.read_root().map_err(|e| format!("read_root: {e}"))?;

    // Sanity gate: round-trip the read value (proven elsewhere, cheap here).
    {
        let mut w = TypeTreeWriter::new(nodes);
        w.write_root(&value_ref).map_err(|e| format!("roundtrip write: {e}"))?;
        if w.finish() != ref_obj {
            return Err("round-trip of the read value is not byte-equal — reader/writer bug, \
                        not a builder bug; aborting before testing build_material_value"
                .into());
        }
    }

    // 3. Extract a UnityMaterial from Value_ref.
    let mat = extract_material(&value_ref)?;
    eprintln!(
        "[verify] extracted: name={:?} shader=(file={}, path={:#x}) tex_envs={} ints={} floats={} colors={}",
        mat.name, mat.shader.file_id, mat.shader.path_id,
        mat.tex_envs.len(), mat.int_props.len(), mat.float_props.len(), mat.color_props.len()
    );

    // 4 + 5. Rebuild and diff against ground truth.
    let value_built = build_material_value(&mat);
    let mut w = TypeTreeWriter::new(nodes);
    w.write_root(&value_built).map_err(|e| format!("build write: {e}"))?;
    let our_bytes = w.finish();
    eprintln!("[verify] our Material:       {} bytes", our_bytes.len());

    if our_bytes == ref_obj {
        eprintln!("[verify] ✓ BYTE-EQUAL ✓");
        Ok(())
    } else {
        let min = our_bytes.len().min(ref_obj.len());
        for i in 0..min {
            if our_bytes[i] != ref_obj[i] {
                let s = i.saturating_sub(8);
                let e = (i + 16).min(min);
                eprintln!("[verify] first diff at offset {i}: ref={:02x} ours={:02x}", ref_obj[i], our_bytes[i]);
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

// --- Value accessors. The reader returns leaves unsigned-by-byte_size, so
// floats arrive as U32 bit patterns and signed ints as their unsigned form;
// LE bytes are identical, so we reinterpret here. ---

fn seq(v: &Value) -> Result<&[Value], String> {
    match v {
        Value::Seq(s) => Ok(s),
        other => Err(format!("expected Seq, got {other:?}")),
    }
}
fn arr(v: &Value) -> Result<&[Value], String> {
    match v {
        Value::Array(a) => Ok(a),
        other => Err(format!("expected Array, got {other:?}")),
    }
}
fn as_string(v: &Value) -> Result<String, String> {
    match v {
        Value::String(s) => Ok(s.clone()),
        Value::Bytes(b) => Ok(String::from_utf8_lossy(b).into_owned()),
        other => Err(format!("expected String, got {other:?}")),
    }
}
fn as_u32(v: &Value) -> Result<u32, String> {
    match v {
        Value::U32(x) => Ok(*x),
        Value::I32(x) => Ok(*x as u32),
        other => Err(format!("expected 4-byte scalar, got {other:?}")),
    }
}
fn as_u8(v: &Value) -> Result<u8, String> {
    match v {
        Value::U8(x) => Ok(*x),
        Value::Bool(b) => Ok(*b as u8),
        other => Err(format!("expected 1-byte scalar, got {other:?}")),
    }
}
fn as_i64(v: &Value) -> Result<i64, String> {
    match v {
        Value::U64(x) => Ok(*x as i64),
        Value::I64(x) => Ok(*x),
        other => Err(format!("expected 8-byte scalar, got {other:?}")),
    }
}
fn as_f32(v: &Value) -> Result<f32, String> {
    Ok(f32::from_bits(as_u32(v)?))
}
fn as_pptr(v: &Value) -> Result<PPtr, String> {
    let s = seq(v)?;
    Ok(PPtr {
        file_id: as_u32(&s[0])? as i32,
        path_id: as_i64(&s[1])?,
    })
}

fn extract_material(v: &Value) -> Result<UnityMaterial, String> {
    let c = seq(v)?;
    if c.len() != 12 {
        return Err(format!("expected 12 root children, got {}", c.len()));
    }
    let strings = |vv: &Value| -> Result<Vec<String>, String> { arr(vv)?.iter().map(as_string).collect() };

    let tex_envs = arr(&seq(&c[10])?[0])?
        .iter()
        .map(|pair| {
            let p = seq(pair)?;
            let te = seq(&p[1])?; // UnityTexEnv: m_Texture, m_Scale, m_Offset
            let scale = seq(&te[1])?;
            let offset = seq(&te[2])?;
            Ok((
                as_string(&p[0])?,
                TexEnv {
                    texture: as_pptr(&te[0])?,
                    scale: [as_f32(&scale[0])?, as_f32(&scale[1])?],
                    offset: [as_f32(&offset[0])?, as_f32(&offset[1])?],
                },
            ))
        })
        .collect::<Result<Vec<_>, String>>()?;

    let saved = seq(&c[10])?;
    let int_props = arr(&saved[1])?
        .iter()
        .map(|pair| {
            let p = seq(pair)?;
            Ok((as_string(&p[0])?, as_u32(&p[1])? as i32))
        })
        .collect::<Result<Vec<_>, String>>()?;
    let float_props = arr(&saved[2])?
        .iter()
        .map(|pair| {
            let p = seq(pair)?;
            Ok((as_string(&p[0])?, as_f32(&p[1])?))
        })
        .collect::<Result<Vec<_>, String>>()?;
    let color_props = arr(&saved[3])?
        .iter()
        .map(|pair| {
            let p = seq(pair)?;
            let rgba = seq(&p[1])?;
            Ok((
                as_string(&p[0])?,
                [as_f32(&rgba[0])?, as_f32(&rgba[1])?, as_f32(&rgba[2])?, as_f32(&rgba[3])?],
            ))
        })
        .collect::<Result<Vec<_>, String>>()?;

    let string_tag_map = arr(&c[8])?
        .iter()
        .map(|pair| {
            let p = seq(pair)?;
            Ok((as_string(&p[0])?, as_string(&p[1])?))
        })
        .collect::<Result<Vec<_>, String>>()?;

    Ok(UnityMaterial {
        name: as_string(&c[0])?,
        shader: as_pptr(&c[1])?,
        valid_keywords: strings(&c[2])?,
        invalid_keywords: strings(&c[3])?,
        lightmap_flags: as_u32(&c[4])?,
        enable_instancing_variants: as_u8(&c[5])?,
        double_sided_gi: as_u8(&c[6])?,
        custom_render_queue: as_u32(&c[7])? as i32,
        string_tag_map,
        disabled_shader_passes: strings(&c[9])?,
        tex_envs,
        int_props,
        float_props,
        color_props,
        build_texture_stacks: strings(&c[11])?,
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
