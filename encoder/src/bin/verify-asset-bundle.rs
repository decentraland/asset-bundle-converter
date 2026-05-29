//! Verify the AssetBundle writer (class 142).

use std::process::ExitCode;

use dcl_asset_bundle_encoder::encode::class_writers::{
    build_asset_bundle_value, AssetBundleEntry, AssetInfo, PPtr, UnityAssetBundle,
};
use dcl_asset_bundle_encoder::encode::serialized_file_reader::parse_serialized_file;
use dcl_asset_bundle_encoder::encode::type_tree::TypeTreeWriter;
use dcl_asset_bundle_encoder::encode::unityfs_writer::parse_bundle;

const ASSETBUNDLE_CLASS_ID: i32 = 142;

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().collect();
    if args.len() != 2 {
        eprintln!("usage: verify-asset-bundle <bundle>");
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
        ASSETBUNDLE_CLASS_ID,
    ) {
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
    let ref_obj = extract_first_object_bytes(sf, ASSETBUNDLE_CLASS_ID)?;
    eprintln!("[verify] reference AssetBundle: {} bytes", ref_obj.len());

    // Parse the reference AssetBundle. Mirror the field order from
    // dump_class_tree -- 142.
    let mut p = Parser::new(ref_obj);

    let name = p.read_string_aligned();
    eprintln!("[verify] name: '{}'", name);
    let preload_count = p.read_u32() as usize;
    let mut preload_table = Vec::with_capacity(preload_count);
    for _ in 0..preload_count {
        preload_table.push(p.read_pptr());
    }
    eprintln!("[verify] preload_table: {preload_count} entries");

    let container_count = p.read_u32() as usize;
    let mut container = Vec::with_capacity(container_count);
    for _ in 0..container_count {
        let asset_path = p.read_string_aligned();
        let preload_index = p.read_i32();
        let preload_size = p.read_i32();
        let asset_pptr = p.read_pptr();
        container.push(AssetBundleEntry {
            asset_path,
            preload_index,
            preload_size,
            asset_pptr,
        });
    }
    eprintln!("[verify] container: {container_count} entries");

    let main_asset = AssetInfo {
        preload_index: p.read_i32(),
        preload_size: p.read_i32(),
        asset: p.read_pptr(),
    };

    let runtime_compatibility = p.read_u32();
    let asset_bundle_name = p.read_string_aligned();
    eprintln!("[verify] runtime_compat={runtime_compatibility}, ab_name='{asset_bundle_name}'");

    let dep_count = p.read_u32() as usize;
    let mut dependencies = Vec::with_capacity(dep_count);
    for _ in 0..dep_count {
        dependencies.push(p.read_string_aligned());
    }
    eprintln!("[verify] dependencies: {dep_count} entries");

    let is_streamed_scene = p.read_bool();
    p.align(4); // m_IsStreamedSceneAssetBundle has ALIGN flag
    let explicit_data_layout = p.read_i32();
    let path_flags = p.read_i32();

    let scene_count = p.read_u32() as usize;
    let mut scene_hashes = Vec::with_capacity(scene_count);
    for _ in 0..scene_count {
        scene_hashes.push((p.read_string_aligned(), p.read_string_aligned()));
    }
    eprintln!("[verify] scene_hashes: {scene_count} entries, remaining bytes: {}", ref_obj.len() - p.pos);

    let ab = UnityAssetBundle {
        name,
        preload_table,
        container,
        main_asset,
        runtime_compatibility,
        asset_bundle_name,
        dependencies,
        is_streamed_scene,
        explicit_data_layout,
        path_flags,
        scene_hashes,
    };

    let value = build_asset_bundle_value(&ab);
    let nodes = db.get(ASSETBUNDLE_CLASS_ID).ok_or("class 142 not in fixture")?;
    let mut writer = TypeTreeWriter::new(nodes);
    writer.write_root(&value).map_err(|e| format!("write: {e}"))?;
    let our_bytes = writer.finish();
    eprintln!("[verify] our AssetBundle:       {} bytes", our_bytes.len());

    if our_bytes == ref_obj {
        eprintln!("[verify] ✓ BYTE-EQUAL ✓");
        Ok(())
    } else {
        let min = our_bytes.len().min(ref_obj.len());
        for i in 0..min {
            if our_bytes[i] != ref_obj[i] {
                eprintln!(
                    "[verify] first diff at offset {i}: ref={:02x} ours={:02x}",
                    ref_obj[i], our_bytes[i]
                );
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
    fn new(buf: &'a [u8]) -> Self {
        Self { buf, pos: 0 }
    }
    fn read_u32(&mut self) -> u32 {
        let v = u32::from_le_bytes(self.buf[self.pos..self.pos + 4].try_into().unwrap());
        self.pos += 4;
        v
    }
    fn read_i32(&mut self) -> i32 {
        self.read_u32() as i32
    }
    fn read_i64(&mut self) -> i64 {
        let v = i64::from_le_bytes(self.buf[self.pos..self.pos + 8].try_into().unwrap());
        self.pos += 8;
        v
    }
    fn read_bool(&mut self) -> bool {
        let v = self.buf[self.pos] != 0;
        self.pos += 1;
        v
    }
    fn read_string_aligned(&mut self) -> String {
        let len = self.read_u32() as usize;
        let s = std::str::from_utf8(&self.buf[self.pos..self.pos + len]).unwrap_or("").to_string();
        self.pos += len;
        self.align(4);
        s
    }
    fn read_pptr(&mut self) -> PPtr {
        PPtr {
            file_id: self.read_i32(),
            path_id: self.read_i64(),
        }
    }
    fn align(&mut self, n: usize) {
        let pad = (n - (self.pos % n)) % n;
        self.pos += pad;
    }
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
