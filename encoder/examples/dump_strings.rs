//! Dump the per-blob string buffer for a given class. Helps identify
//! field names that live in the local buffer (no high-bit set on
//! offset) vs. those that reference Unity's common-strings table.

use dcl_asset_bundle_encoder::encode::typetree_fixture::parse_fixture;

fn main() {
    let class_id: i32 = std::env::args()
        .nth(1)
        .expect("class_id required")
        .parse()
        .expect("class_id must be integer");
    // Scan all regenerable fixtures (gitignored — see regenerate-fixtures.sh).
    let dir = dcl_asset_bundle_encoder::encode::type_tree_db::FIXTURE_DIR;
    let paths: Vec<std::path::PathBuf> = std::fs::read_dir(dir)
        .into_iter()
        .flatten()
        .filter_map(|e| e.ok().map(|e| e.path()))
        .filter(|p| p.extension().map(|x| x == "bin").unwrap_or(false))
        .collect();
    for path in &paths {
        let Ok(bytes) = std::fs::read(path) else { continue };
        let Ok(fixture) = parse_fixture(&bytes) else { continue };
        for entry in &fixture.entries {
            if entry.class_id != class_id {
                continue;
            }
            let blob = &entry.type_tree_blob;
            let node_count = u32::from_le_bytes(blob[0..4].try_into().unwrap()) as usize;
            let string_buf_size =
                u32::from_le_bytes(blob[4..8].try_into().unwrap()) as usize;
            let records_end = 8 + node_count * 32;
            let buf = &blob[records_end..records_end + string_buf_size];
            println!("class {class_id} (from {}):", path.display());
            println!("  per-blob string buffer: {} bytes", buf.len());
            // Print strings null-by-null with their offsets.
            let mut cur = 0;
            while cur < buf.len() {
                let end = buf[cur..].iter().position(|&b| b == 0).unwrap_or(buf.len() - cur);
                let s = std::str::from_utf8(&buf[cur..cur + end]).unwrap_or("?");
                println!("    @{cur:3}: \"{s}\"");
                cur += end + 1;
            }
            return;
        }
    }
    eprintln!("class {class_id} not found");
}
