//! TypeTree-driven field reader. Walks a class's TypeTree against the
//! real object bytes from a bundle, printing each field's offset, type,
//! size, and interpreted value. The inverse of our writer.
//!
//! This is the diagnostic that makes layout divergence VISIBLE rather
//! than hand-counted. If the walk consumes exactly the object's byte
//! span and ends at the boundary, the layout is understood. If it
//! diverges, the printed offset where values stop making sense pinpoints
//! the bug.
//!
//! Usage:
//!   cargo run --bin dump-fields --no-default-features -- <bundle> <class_id>

use std::process::ExitCode;

use dcl_asset_bundle_encoder::encode::serialized_file_reader::parse_serialized_file;
use dcl_asset_bundle_encoder::encode::type_tree::{flags, TypeTreeNode};
use dcl_asset_bundle_encoder::encode::type_tree_db::TypeTreeDb;
use dcl_asset_bundle_encoder::encode::unityfs_writer::parse_bundle;

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().collect();
    if args.len() != 3 {
        eprintln!("usage: dump-fields <bundle> <class_id>");
        return ExitCode::from(2);
    }
    let class_id: i32 = args[2].parse().expect("class_id int");
    match run(&args[1], class_id) {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => {
            eprintln!("FAILED: {e}");
            ExitCode::FAILURE
        }
    }
}

fn run(bundle_path: &str, class_id: i32) -> Result<(), String> {
    // Use whichever fixture has the class.
    let db = load_db_with_class(class_id)?;
    let nodes = db.get(class_id).ok_or("class not in fixture")?;

    let bytes = std::fs::read(bundle_path).map_err(|e| format!("{e}"))?;
    let parsed = parse_bundle(&bytes).map_err(|e| format!("{e}"))?;
    let sf_node = parsed.directory.iter().find(|n| !n.path.ends_with(".resS")).ok_or("no SF")?;
    let sf = &parsed.data_payload_uncompressed[sf_node.offset as usize..(sf_node.offset + sf_node.size) as usize];
    let obj = extract_first_object_bytes(sf, class_id)?;
    eprintln!("[dump-fields] class {class_id}: object is {} bytes", obj.len());

    let mut r = Reader { buf: obj, pos: 0 };
    // The root node (index 0) is the object itself; walk its children.
    walk(nodes, 0, &mut r, 0)?;

    eprintln!(
        "[dump-fields] walk ended at offset {} of {} ({})",
        r.pos,
        obj.len(),
        if r.pos == obj.len() { "✓ EXACT" } else { "✗ MISMATCH" }
    );
    Ok(())
}

struct Reader<'a> {
    buf: &'a [u8],
    pos: usize,
}

impl<'a> Reader<'a> {
    fn take(&mut self, n: usize) -> Result<&'a [u8], String> {
        if self.pos + n > self.buf.len() {
            return Err(format!("read past end: pos={} + {n} > {}", self.pos, self.buf.len()));
        }
        let s = &self.buf[self.pos..self.pos + n];
        self.pos += n;
        Ok(s)
    }
    fn align4(&mut self) {
        let pad = (4 - (self.pos % 4)) % 4;
        self.pos += pad;
    }
}

/// Walk one node against the byte stream, printing leaves.
fn walk(nodes: &[TypeTreeNode], idx: usize, r: &mut Reader, depth: usize) -> Result<(), String> {
    let node = &nodes[idx];
    let indent = "  ".repeat(depth);
    let start = r.pos;

    if node.is_array {
        // Array container: child[0] = size (i32), child[1] = element.
        let size_bytes = r.take(4)?;
        let count = u32::from_le_bytes(size_bytes.try_into().unwrap()) as usize;
        eprintln!(
            "{indent}@{start} {} {} [ARRAY count={count}]",
            node.type_name, node.name
        );
        let elem = node.children[1];
        for i in 0..count {
            // Avoid spamming for big arrays; print first 3 + last.
            if i < 3 || i == count - 1 {
                walk(nodes, elem, r, depth + 1)?;
            } else {
                // still consume, but quietly
                let mut sink = Reader { buf: r.buf, pos: r.pos };
                walk_quiet(nodes, elem, &mut sink)?;
                r.pos = sink.pos;
                if i == 3 {
                    eprintln!("{indent}  ... ({} more elements)", count - 4);
                }
            }
        }
    } else if node.children.is_empty() {
        // Leaf — read byte_size bytes and interpret.
        let sz = node.byte_size.max(0) as usize;
        let raw = r.take(sz)?;
        let val = interpret(&node.type_name, raw);
        eprintln!("{indent}@{start} {} {} (size={sz}) = {val}", node.type_name, node.name);
    } else {
        // Struct or wrapper. Special-case the string wrapper: a node
        // whose single child is itself an Array of char/UInt8 → emit as
        // string. Detect via: 1 child that is_array with byte element.
        if is_string_wrapper(nodes, idx) {
            let child = node.children[0]; // the Array node
            let len_bytes = r.take(4)?;
            let len = u32::from_le_bytes(len_bytes.try_into().unwrap()) as usize;
            let str_bytes = r.take(len)?;
            let s = String::from_utf8_lossy(str_bytes);
            eprintln!("{indent}@{start} string {} = \"{s}\"", node.name);
            // string's inner Array child carries ALIGN; apply.
            if nodes[child].meta_flag & flags::ALIGN_BYTES != 0
                || node.meta_flag & flags::ALIGN_BYTES != 0
            {
                r.align4();
            }
            // The string field is fully consumed; skip the generic
            // child recursion + the generic align below.
            return Ok(());
        }
        eprintln!("{indent}@{start} {} {} [STRUCT children={}]", node.type_name, node.name, node.children.len());
        let kids = node.children.clone();
        for k in kids {
            walk(nodes, k, r, depth + 1)?;
        }
    }

    // Apply ALIGN_BYTES after the field if set.
    if node.meta_flag & flags::ALIGN_BYTES != 0 {
        r.align4();
    }
    Ok(())
}

/// Consume bytes for a node without printing (for array element skipping).
fn walk_quiet(nodes: &[TypeTreeNode], idx: usize, r: &mut Reader) -> Result<(), String> {
    let node = &nodes[idx];
    if node.is_array {
        let count = u32::from_le_bytes(r.take(4)?.try_into().unwrap()) as usize;
        let elem = node.children[1];
        for _ in 0..count {
            walk_quiet(nodes, elem, r)?;
        }
    } else if node.children.is_empty() {
        r.take(node.byte_size.max(0) as usize)?;
    } else if is_string_wrapper(nodes, idx) {
        let len = u32::from_le_bytes(r.take(4)?.try_into().unwrap()) as usize;
        r.take(len)?;
        r.align4();
        return Ok(());
    } else {
        let kids = node.children.clone();
        for k in kids {
            walk_quiet(nodes, k, r)?;
        }
    }
    if node.meta_flag & flags::ALIGN_BYTES != 0 {
        r.align4();
    }
    Ok(())
}

/// A string in Unity TypeTrees is a node with one child that is an
/// `is_array` Array whose element is a 1-byte char/UInt8.
fn is_string_wrapper(nodes: &[TypeTreeNode], idx: usize) -> bool {
    let node = &nodes[idx];
    if node.children.len() != 1 {
        return false;
    }
    let child = &nodes[node.children[0]];
    if !child.is_array || child.children.len() != 2 {
        return false;
    }
    let elem = &nodes[child.children[1]];
    elem.byte_size == 1 && elem.children.is_empty()
        // "string" type name often resolves; also accept char/UInt8 elem.
        && (node.type_name == "string" || node.type_name.starts_with("common@"))
}

fn interpret(type_name: &str, raw: &[u8]) -> String {
    match (type_name, raw.len()) {
        ("bool", 1) => format!("{}", raw[0] != 0),
        (_, 1) => format!("{} (0x{:02x})", raw[0], raw[0]),
        (_, 2) => {
            let v = u16::from_le_bytes(raw.try_into().unwrap());
            format!("{v} (i16={})", v as i16)
        }
        ("float", 4) => format!("{}", f32::from_le_bytes(raw.try_into().unwrap())),
        (_, 4) => {
            let v = u32::from_le_bytes(raw.try_into().unwrap());
            format!("{v} (i32={}, f32={})", v as i32, f32::from_le_bytes(raw.try_into().unwrap()))
        }
        (_, 8) => {
            let v = i64::from_le_bytes(raw.try_into().unwrap());
            format!("{v} (0x{:016x})", v as u64)
        }
        _ => format!("{raw:02x?}"),
    }
}

fn load_db_with_class(class_id: i32) -> Result<TypeTreeDb, String> {
    // Fixtures are gitignored + regenerated on demand. The lib helper
    // scans baked-fixtures/typetrees/*.bin for one containing the class.
    dcl_asset_bundle_encoder::encode::type_tree_db::load_fixture_with_class(class_id)
        .ok_or_else(|| format!("no fixture has class {class_id} — run scripts/regenerate-fixtures.sh"))
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
