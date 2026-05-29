//! Dump the parsed TypeTree for a given class_id from the real fixture.
//! Usage: cargo run --example dump_class_tree -- <class_id>

use dcl_asset_bundle_encoder::encode::type_tree_db::load_fixture_with_class;

fn main() {
    let class_id: i32 = std::env::args()
        .nth(1)
        .expect("class_id arg required")
        .parse()
        .expect("class_id must be an integer");
    // Scans baked-fixtures/typetrees/*.bin for one with this class.
    // Fixtures are regenerated on demand (scripts/regenerate-fixtures.sh).
    let Some(db) = load_fixture_with_class(class_id) else {
        eprintln!("class {class_id} not in any fixture — run scripts/regenerate-fixtures.sh");
        std::process::exit(1);
    };
    let Some(nodes) = db.get(class_id) else {
        eprintln!("class {class_id} not in fixture");
        std::process::exit(1);
    };
    println!("class_id={class_id}, {} nodes:", nodes.len());
    for (i, n) in nodes.iter().enumerate() {
        let indent = "  ".repeat(n.level as usize);
        println!(
            "{i:3}: {indent}{} {} (size={}, idx={}, meta=0x{:04x}, children={})",
            n.type_name,
            n.name,
            n.byte_size,
            n.index,
            n.meta_flag,
            n.children.len()
        );
    }
}
