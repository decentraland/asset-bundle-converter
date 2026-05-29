//! Verify the texture writer against a real Unity texture bundle.
//!
//! Workflow:
//!   1. Read a real reference bundle (must be a Texture2D bundle —
//!      we don't yet emit Material/Mesh/etc).
//!   2. Decode it through our reader → ParsedBundle + SerializedFile.
//!   3. Identify the Texture2D object's bytes inside the reference.
//!   4. Run our writer against a synthetic PNG (same dimensions as the
//!      reference's declared Texture2D), produce an encoder bundle.
//!   5. Decode the encoder bundle the same way → SerializedFile.
//!   6. Compare the Texture2D object bytes byte-by-byte and report
//!      first-diff offset + surrounding context.
//!
//! Usage:
//!   cargo run --bin verify-texture-bundle --no-default-features -- <reference.assetbundle>
//!
//! This is the iteration loop for tightening texture_writer.rs until
//! its output is byte-equivalent to Unity's. Each "first diff at offset
//! N" tells us one field is wrong.

use std::process::ExitCode;

use dcl_asset_bundle_encoder::encode::serialized_file_reader::parse_serialized_file;
use dcl_asset_bundle_encoder::encode::texture_writer::{
    serialize_texture2d, UnityTexture2D, TEXTURE_FORMAT_RGBA32,
};
use dcl_asset_bundle_encoder::encode::unityfs_writer::parse_bundle;

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().collect();
    if args.len() != 2 {
        eprintln!("usage: verify-texture-bundle <reference.assetbundle>");
        return ExitCode::from(2);
    }
    let path = &args[1];
    match run(path) {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => {
            eprintln!("[verify] FAILED: {e}");
            ExitCode::FAILURE
        }
    }
}

fn run(reference_path: &str) -> Result<(), String> {
    // Load a TypeTree fixture containing Texture2D (class 28).
    // Fixtures are regenerated on demand (scripts/regenerate-fixtures.sh).
    let db = match dcl_asset_bundle_encoder::encode::type_tree_db::load_fixture_with_class(28) {
        Some(db) => db,
        None => {
            eprintln!("[verify] no Texture2D fixture — run scripts/regenerate-fixtures.sh; skipping");
            return Ok(());
        }
    };

    // 1. Parse the reference bundle.
    let ref_bytes = std::fs::read(reference_path).map_err(|e| format!("read {reference_path}: {e}"))?;
    let ref_bundle = parse_bundle(&ref_bytes).map_err(|e| format!("ref UnityFS parse: {e}"))?;
    eprintln!(
        "[verify] reference: {} bytes, unity_revision={}",
        ref_bytes.len(),
        ref_bundle.unity_revision
    );
    if ref_bundle.unity_revision != db.unity_version {
        eprintln!(
            "[verify] WARN: fixture unity_version={} but reference says {} — diffs may include version-skew noise",
            db.unity_version, ref_bundle.unity_revision
        );
    }

    let sf_node = ref_bundle
        .directory
        .iter()
        .find(|n| !n.path.ends_with(".resS"))
        .ok_or("reference has no SerializedFile node")?;
    let sf_bytes = &ref_bundle.data_payload_uncompressed
        [sf_node.offset as usize..(sf_node.offset + sf_node.size) as usize];
    let ref_sf = parse_serialized_file(sf_bytes).map_err(|e| format!("ref SF parse: {e}"))?;
    eprintln!(
        "[verify] reference SF: {} types: {:?}",
        ref_sf.types.len(),
        ref_sf.types.iter().map(|t| t.class_id).collect::<Vec<_>>()
    );

    // 2. Find the Texture2D object record. We re-parse the metadata
    //    section directly to get object byte_start / byte_size — the
    //    existing parser doesn't expose them.
    let (tex_obj_start, tex_obj_size, tex_obj_bytes) = locate_texture2d_object(&ref_sf, sf_bytes)?;
    eprintln!(
        "[verify] reference Texture2D object: start={tex_obj_start}, size={tex_obj_size}"
    );

    // 3. Produce our encoder's output. Use a synthetic PNG matching the
    //    reference's declared dimensions if we can extract them, else
    //    a small placeholder. (Production verification will use the
    //    same source PNG Unity built from.)
    //
    // For now, build a 2×2 RGBA32 placeholder. The bytes won't match
    // the reference's image data (different inputs), but every OTHER
    // field should. Diff focuses on layout / field encoding bugs.
    let placeholder = UnityTexture2D {
        name: "placeholder".to_string(),
        width: 2,
        height: 2,
        texture_format: TEXTURE_FORMAT_RGBA32,
        mip_count: 1,
        color_space: 1,
        image_data: vec![0xff; 16], // 2x2 RGBA = 16 bytes
    };
    let our_bytes = serialize_texture2d(&placeholder, &db).map_err(|e| format!("our serialize: {e}"))?;
    eprintln!("[verify] our Texture2D object: {} bytes", our_bytes.len());

    // 4. Byte-diff. We're looking for STRUCTURAL bugs — same field
    //    layout, same alignment, same wire format. The actual values
    //    differ (different inputs), but field boundaries should match.
    //
    // Find first byte position where the difference isn't explainable
    // by the inputs (string lengths, image_data values).
    diff_objects(tex_obj_bytes, &our_bytes);

    Ok(())
}

/// Walk the metadata's object table to find the Texture2D entry and
/// slice out its bytes from the data section.
fn locate_texture2d_object<'a>(
    _sf: &crate::ParsedSerializedFile,
    sf_bytes: &'a [u8],
) -> Result<(u64, u32, &'a [u8]), String> {
    // Re-parse just enough of the metadata to find the object table.
    // Header is 48 bytes (verified); metadata starts at offset 48.
    let metadata_size = i64::from_be_bytes(sf_bytes[0x10..0x18].try_into().unwrap()) as usize;
    let data_offset = i64::from_be_bytes(sf_bytes[0x20..0x28].try_into().unwrap()) as usize;
    let metadata = &sf_bytes[48..48 + metadata_size];

    let mut cur = 0;
    // unity_version cstring
    cur += metadata[cur..].iter().position(|&b| b == 0).unwrap() + 1;
    cur += 4; // target_platform
    cur += 1; // enable_type_tree
    let type_count = i32::from_le_bytes(metadata[cur..cur + 4].try_into().unwrap()) as usize;
    cur += 4;

    // Find which type_index corresponds to class 28 (Texture2D).
    let mut tex_type_index: Option<i32> = None;
    for i in 0..type_count {
        let class_id = i32::from_le_bytes(metadata[cur..cur + 4].try_into().unwrap());
        cur += 4 + 1 + 2; // class_id + is_stripped + sti
        let sti = i16::from_le_bytes(metadata[cur - 2..cur].try_into().unwrap());
        if sti >= 0 {
            cur += 16;
        }
        cur += 16; // old_type_hash
        // skip blob
        let nc = u32::from_le_bytes(metadata[cur..cur + 4].try_into().unwrap()) as usize;
        let sb = u32::from_le_bytes(metadata[cur + 4..cur + 8].try_into().unwrap()) as usize;
        let blob_records = 8 + nc * 32 + sb;
        let dep_count_off = cur + blob_records;
        let dep_count = u32::from_le_bytes(metadata[dep_count_off..dep_count_off + 4].try_into().unwrap()) as usize;
        cur += blob_records + 4 + dep_count * 4;
        if class_id == 28 {
            tex_type_index = Some(i as i32);
        }
    }
    let tex_type_index = tex_type_index.ok_or("reference has no Texture2D type")?;

    // Object table — 4-byte aligned entries: i64 path_id, i64 byte_start,
    // u32 byte_size (BE!), i32 type_index.
    //
    // Note: the header byte_size is u32 BE (Unity's quirky mixed
    // endianness); offset/path_id are LE i64.
    let object_count = i32::from_le_bytes(metadata[cur..cur + 4].try_into().unwrap()) as usize;
    cur += 4;
    let mut section_pos = 4usize; // tracks bytes-written-in-section for alignment
    for _ in 0..object_count {
        // 4-byte align
        let pad = (4 - (section_pos % 4)) % 4;
        cur += pad;
        section_pos += pad;
        let _path_id = i64::from_le_bytes(metadata[cur..cur + 8].try_into().unwrap());
        let byte_start = i64::from_le_bytes(metadata[cur + 8..cur + 16].try_into().unwrap());
        let byte_size = u32::from_le_bytes(metadata[cur + 16..cur + 20].try_into().unwrap());
        let type_index = i32::from_le_bytes(metadata[cur + 20..cur + 24].try_into().unwrap());
        cur += 24;
        section_pos += 24;
        if type_index == tex_type_index {
            let abs_start = data_offset + byte_start as usize;
            let abs_end = abs_start + byte_size as usize;
            return Ok((byte_start as u64, byte_size, &sf_bytes[abs_start..abs_end]));
        }
    }
    Err("Texture2D object not found in object table".into())
}

fn diff_objects(reference: &[u8], ours: &[u8]) {
    eprintln!("[verify] sizes: reference={} ours={}", reference.len(), ours.len());

    // The first field is m_Name (string: u32 LE length + bytes,
    // 4-byte aligned). The names differ between reference and ours.
    // Skip past the name in BOTH so the diff focuses on the fields
    // that should match.
    let skip_name = |buf: &[u8]| -> usize {
        let len = u32::from_le_bytes(buf[0..4].try_into().unwrap()) as usize;
        let after_name = 4 + len;
        let aligned = (after_name + 3) & !3;
        aligned
    };
    let ref_skip = skip_name(reference);
    let our_skip = skip_name(ours);
    eprintln!(
        "[verify] skipping m_Name: reference {} bytes, ours {} bytes",
        ref_skip, our_skip
    );

    let ref_after = &reference[ref_skip..];
    let our_after = &ours[our_skip..];

    eprintln!(
        "[verify] after m_Name: reference {} bytes remain, ours {}",
        ref_after.len(),
        our_after.len()
    );

    let min = ref_after.len().min(our_after.len());
    let mut first_diff: Option<usize> = None;
    for i in 0..min {
        if ref_after[i] != our_after[i] {
            first_diff = Some(i);
            break;
        }
    }
    match first_diff {
        None => {
            if ref_after.len() == our_after.len() {
                eprintln!("[verify] ✓ post-name bytes are byte-equal (structural match)");
            } else {
                eprintln!(
                    "[verify] post-name common prefix matches; length differs by {} bytes — \
                     likely an image_data size mismatch (expected; placeholder PNG is smaller)",
                    (ref_after.len() as i64 - our_after.len() as i64).abs()
                );
            }
        }
        Some(i) => {
            let start = i.saturating_sub(16);
            let end = (i + 32).min(min);
            eprintln!(
                "[verify] first post-name diff at relative offset {i} (0x{i:x})"
            );
            eprintln!(
                "[verify]   reference[{start}..{end}]: {:02x?}",
                &ref_after[start..end]
            );
            eprintln!(
                "[verify]   ours     [{start}..{end}]: {:02x?}",
                &our_after[start..end]
            );
        }
    }
}

// Re-export the parser's `ParsedSerializedFile` type for the helper above.
use dcl_asset_bundle_encoder::encode::serialized_file_reader::ParsedSerializedFile;
