//! TypeTree binary format reader + alignment-aware value writer.
//!
//! ⚠️ STATUS — infrastructure complete, end-to-end UNVERIFIED. The
//! TypeTree binary format Unity emits inside SerializedFiles is
//! reverse-engineered from AssetRipper's reader; the value model and
//! the walker here are correct against that spec. But:
//!
//!   * Without a real TypeTree fixture binary at
//!     `encoder/baked-fixtures/typetrees/2021.3.20f1.bin`, the reader
//!     has nothing to parse — we test the format parser with
//!     hand-crafted fixtures only.
//!   * Per-class writers (Mesh / Material / Texture2D / GameObject)
//!     must produce a `Value` graph that matches the TypeTree's
//!     expectations field-for-field. Mismatches surface as malformed
//!     bundles. Per-class verification is the next phase.
//!
//! What IS verified in this module:
//!   * TypeTree node parsing (read a fixture-style blob, get nodes back).
//!   * Alignment-aware writing (the kAlignBytesFlag tree node attribute
//!     triggers 4-byte padding — easy to test on a hand-built tree).
//!   * Primitive type writes (int / float / bool / string / bytes).
//!
//! What is NOT verified:
//!   * That AssetRipper's interpretation of the TypeTree format matches
//!     Unity 2021.3.20f1 exactly (it has, historically).
//!   * That our value model covers every TypeTree node shape Unity emits.
//!     We handle Array, struct (children), and the documented primitive
//!     leaf types; extension types (e.g. PPtr, ColorRGBA, Vector3f) are
//!     just structs and walk through the recursion correctly.
//!
//! Reference: AssetRipper.IO.Files/SerializedFiles/TypeTree

use super::SerializeError;

// ---------------------------------------------------------------------------
// Node model — one entry per field in a class's TypeTree.
// ---------------------------------------------------------------------------

/// Bit flags Unity stamps on each TypeTree node. The complete set is
/// large; we surface the ones load-bearing for serialisation. Source:
/// AssetRipper.IO.Files/SerializedFiles/TypeTree/TypeTreeNode.cs.
pub mod flags {
    /// After writing this field's bytes, align the output cursor to a
    /// 4-byte boundary by emitting zero padding.
    pub const ALIGN_BYTES: u32 = 0x4000;
    /// At least one child has ALIGN_BYTES set. We can use this as a
    /// fast skip-check when walking trees, but the actual alignment
    /// decision happens per-child.
    pub const ANY_CHILD_USES_ALIGN: u32 = 0x8000;
}

#[derive(Debug, Clone)]
pub struct TypeTreeNode {
    pub level: u8,
    /// Field name — Unity uses these for diff/debug; readers match by
    /// position, not name, so we only need them to drive the per-class
    /// writers (which look up nodes by name when binding values).
    pub name: String,
    /// Type name — drives the leaf-vs-struct decision and the primitive
    /// dispatch. Known leaf types: SInt8, UInt8, SInt16, UInt16, SInt32,
    /// UInt32, SInt64, UInt64, float, double, bool, char, string, TypelessData.
    pub type_name: String,
    /// Byte size of this node when serialised. -1 means variable-size
    /// (string, Array, TypelessData) and the writer reads child Array
    /// nodes to determine the actual size.
    pub byte_size: i32,
    /// Index — Unity tracks per-tree node ordering.
    pub index: i32,
    /// Type flags — only ALIGN_BYTES + ANY_CHILD_USES_ALIGN matter to
    /// the writer.
    pub meta_flag: u32,
    /// Unity's `is_array` byte from the node record (offset +3). When
    /// set, this node is an Array container: child[0] is the `size`
    /// (i32 count) and child[1] is the element type. This is the
    /// authoritative array signal — more reliable than name- or
    /// child-shape heuristics.
    pub is_array: bool,
    /// Convenience: indices of this node's direct children in the
    /// containing tree. Populated by `parse_type_tree_nodes`.
    pub children: Vec<usize>,
}

// ---------------------------------------------------------------------------
// Binary format parser — reads the on-disk TypeTree blob format Unity
// emits in SerializedFile metadata.
//
// Layout (format version 22):
//   u32 LE  node_count
//   u32 LE  string_buffer_size
//   per node (32 bytes):
//     u16 LE version           ← Unity-internal type-version
//     u8       level
//     u8       is_array
//     u32 LE   type_string_offset  ← into string buffer, or hi-bit-set common-string index
//     u32 LE   name_string_offset  ← same encoding
//     i32 LE   byte_size
//     i32 LE   index
//     u32 LE   meta_flag
//     u64 LE   ref_type_hash       ← always 0 for non-RefType classes
//   string buffer (length = string_buffer_size)
// ---------------------------------------------------------------------------

const NODE_RECORD_SIZE: usize = 2 + 1 + 1 + 4 + 4 + 4 + 4 + 4 + 8; // 32

/// Parse a TypeTree binary blob. Returns the parsed node list. Build
/// the parent/child relationships via the `level` field — nodes with
/// level N+1 belong to the most recent level-N ancestor.
pub fn parse_type_tree_nodes(blob: &[u8]) -> Result<Vec<TypeTreeNode>, SerializeError> {
    if blob.len() < 8 {
        return Err(SerializeError::Format("TypeTree blob too short".into()));
    }
    let node_count = u32::from_le_bytes(blob[0..4].try_into().unwrap()) as usize;
    let string_buffer_size = u32::from_le_bytes(blob[4..8].try_into().unwrap()) as usize;

    let node_records_start = 8usize;
    let node_records_end = node_records_start
        .checked_add(node_count.checked_mul(NODE_RECORD_SIZE).ok_or_else(|| {
            SerializeError::Format("TypeTree node count overflow".into())
        })?)
        .ok_or_else(|| SerializeError::Format("TypeTree node records overflow".into()))?;
    let string_buffer_end = node_records_end
        .checked_add(string_buffer_size)
        .ok_or_else(|| SerializeError::Format("TypeTree string buffer overflow".into()))?;
    if blob.len() < string_buffer_end {
        return Err(SerializeError::Format(format!(
            "TypeTree blob truncated: expected at least {string_buffer_end} bytes, got {}",
            blob.len()
        )));
    }
    let string_buffer = &blob[node_records_end..string_buffer_end];

    let mut nodes = Vec::with_capacity(node_count);
    for i in 0..node_count {
        let off = node_records_start + i * NODE_RECORD_SIZE;
        let _version = u16::from_le_bytes(blob[off..off + 2].try_into().unwrap());
        let level = blob[off + 2];
        let is_array = blob[off + 3] != 0;
        let type_off = u32::from_le_bytes(blob[off + 4..off + 8].try_into().unwrap());
        let name_off = u32::from_le_bytes(blob[off + 8..off + 12].try_into().unwrap());
        let byte_size = i32::from_le_bytes(blob[off + 12..off + 16].try_into().unwrap());
        let index = i32::from_le_bytes(blob[off + 16..off + 20].try_into().unwrap());
        let meta_flag = u32::from_le_bytes(blob[off + 20..off + 24].try_into().unwrap());
        // _ref_type_hash (u64) at off+24..off+32 — unused by our writer.

        nodes.push(TypeTreeNode {
            level,
            name: resolve_string(name_off, string_buffer)?,
            type_name: resolve_string(type_off, string_buffer)?,
            byte_size,
            index,
            meta_flag,
            is_array,
            children: Vec::new(),
        });
    }

    // Wire up children via the level field — a node at level L+1 is a
    // child of the most recent node at level L.
    let mut stack: Vec<usize> = Vec::new();
    for i in 0..nodes.len() {
        let level = nodes[i].level as usize;
        while stack.len() > level {
            stack.pop();
        }
        if let Some(&parent_idx) = stack.last() {
            nodes[parent_idx].children.push(i);
        }
        stack.push(i);
    }

    Ok(nodes)
}

/// String offsets in TypeTree node records use the high bit as a flag:
/// when set, the low 31 bits are a BYTE OFFSET into Unity's common-
/// strings buffer. When clear, they're offsets into the per-blob string
/// buffer.
///
/// We don't ship the full common-strings buffer (it's ~1.2 KiB and
/// would need byte-perfect reconstruction from AssetRipper). Indices
/// the small `COMMON_STRINGS` table covers resolve to real names;
/// uncovered ones fall back to `"common@{offset}"` placeholders. The
/// TypeTree-driven writer's `write_struct_node` matches Value::Struct
/// children by these names, so per-class Value builders use whichever
/// form `resolve_string` produced (real name or placeholder).
fn resolve_string(offset: u32, string_buffer: &[u8]) -> Result<String, SerializeError> {
    if offset & 0x8000_0000 != 0 {
        let idx = (offset & 0x7fff_ffff) as usize;
        Ok(common_strings_lookup(idx)
            .map(|s| s.to_string())
            .unwrap_or_else(|| format!("common@{idx}")))
    } else {
        let start = offset as usize;
        if start >= string_buffer.len() {
            return Err(SerializeError::Format(format!(
                "TypeTree string offset {start} >= buffer size {}",
                string_buffer.len()
            )));
        }
        // Strings are null-terminated.
        let null = string_buffer[start..]
            .iter()
            .position(|&b| b == 0)
            .ok_or_else(|| SerializeError::Format("TypeTree string not null-terminated".into()))?;
        std::str::from_utf8(&string_buffer[start..start + null])
            .map(|s| s.to_string())
            .map_err(|e| SerializeError::Format(format!("TypeTree string not UTF-8: {e}")))
    }
}

// Unity's common-strings table — embedded into the engine, indexed by
// the high-bit-set offsets above. Without these, every TypeTree would
// duplicate the same field name strings ("m_Name", "data", etc.).
// AssetRipper publishes the full table; the entries here are the
// most-common subset our writers actually need. Add more if a fixture
// turns up indices we don't cover.
//
// Each entry's array index doubles as the lookup key.
const COMMON_STRINGS: &[&str] = &[
    "",                       // 0  — reserved by Unity for "empty string"
    "AABB",                   // 1
    "AnimationClip",          // 2
    "AnimationCurve",         // 3
    "AnimationState",         // 4
    "Array",                  // 5
    "Base",                   // 6
    "BitField",               // 7
    "bitset",                 // 8
    "bool",                   // 9
    "char",                   // 10
    "ColorRGBA",              // 11
    "Component",              // 12
    "data",                   // 13
    "deque",                  // 14
    "double",                 // 15
    "dynamic_array",          // 16
    "FastPropertyName",       // 17
    "first",                  // 18
    "float",                  // 19
    "Font",                   // 20
    "GameObject",             // 21
    "Generic Mono",           // 22
    "GradientNEW",            // 23
    "GUID",                   // 24
    "GUIStyle",               // 25
    "int",                    // 26
    "list",                   // 27
    "long long",              // 28
    "map",                    // 29
    "Matrix4x4f",             // 30
    "MdFour",                 // 31
    "MonoBehaviour",          // 32
    "MonoScript",             // 33
    "m_ByteSize",             // 34
    "m_Curve",                // 35
    "m_EditorClassIdentifier", // 36
    "m_EditorHideFlags",      // 37
    "m_Enabled",              // 38
    "m_ExtensionPtr",         // 39
    "m_GameObject",           // 40
    "m_Index",                // 41
    "m_IsArray",              // 42
    "m_IsStatic",             // 43
    "m_MetaFlag",             // 44
    "m_Name",                 // 45
    "m_ObjectHideFlags",      // 46
    "m_PrefabInternal",       // 47
    "m_PrefabParentObject",   // 48
    "m_Script",               // 49
    "m_StaticEditorFlags",    // 50
    "m_Type",                 // 51
    "m_Version",              // 52
    "Object",                 // 53
    "pair",                   // 54
    "PPtr<Component>",        // 55
    "PPtr<GameObject>",       // 56
    "PPtr<Material>",         // 57
    "PPtr<MonoBehaviour>",    // 58
    "PPtr<MonoScript>",       // 59
    "PPtr<Object>",           // 60
    "PPtr<Prefab>",           // 61
    "PPtr<Sprite>",           // 62
    "PPtr<TextAsset>",        // 63
    "PPtr<Texture>",          // 64
    "PPtr<Texture2D>",        // 65
    "PPtr<Transform>",        // 66
    "Prefab",                 // 67
    "Quaternionf",            // 68
    "Rectf",                  // 69
    "RectInt",                // 70
    "RectOffset",             // 71
    "second",                 // 72
    "set",                    // 73
    "short",                  // 74
    "size",                   // 75
    "SInt16",                 // 76
    "SInt32",                 // 77
    "SInt64",                 // 78
    "SInt8",                  // 79
    "staticvector",           // 80
    "string",                 // 81
    "TextAsset",              // 82
    "TextMesh",               // 83
    "Texture",                // 84
    "Texture2D",              // 85
    "Transform",              // 86
    "TypelessData",           // 87
    "UInt16",                 // 88
    "UInt32",                 // 89
    "UInt64",                 // 90
    "UInt8",                  // 91
    "unsigned int",           // 92
    "unsigned long long",     // 93
    "unsigned short",         // 94
    "vector",                 // 95
    "Vector2f",               // 96
    "Vector3f",               // 97
    "Vector4f",               // 98
    "m_ScriptingClassIdentifier", // 99
    "Gradient",               // 100
];

fn common_strings_lookup(idx: usize) -> Option<&'static str> {
    COMMON_STRINGS.get(idx).copied()
}

// ---------------------------------------------------------------------------
// Value model — the per-class writers populate one of these per top-level
// object and hand it to `write_value_with_tree`.
// ---------------------------------------------------------------------------

/// Generic field value, matching the leaf and aggregate shapes Unity's
/// TypeTree can describe. The writer dispatches on Value variant vs.
/// TypeTreeNode.type_name to emit the correct bytes.
#[derive(Debug, Clone)]
pub enum Value {
    Bool(bool),
    I8(i8),
    U8(u8),
    I16(i16),
    U16(u16),
    I32(i32),
    U32(u32),
    I64(i64),
    U64(u64),
    F32(f32),
    F64(f64),
    /// Variable-length string with a u32 length prefix (Unity's `string`
    /// type). UTF-8.
    String(String),
    /// Raw bytes — written as a length-prefixed array. Used for
    /// TypelessData (texture image_data, mesh vertex_data, etc.).
    Bytes(Vec<u8>),
    /// Variable-length array of homogeneous values. Length-prefixed
    /// (u32 LE).
    Array(Vec<Value>),
    /// Struct — child name → child value. Walked by visiting the
    /// TypeTreeNode's children in order, looking up each by name.
    /// Useful when field names are known (mostly tests).
    Struct(std::collections::BTreeMap<String, Value>),
    /// Struct — positional. Length must match the TypeTreeNode's
    /// children count, values are written in child-position order.
    /// Used by production per-class builders, which know each class's
    /// field order from the TypeTree dump — this dodges the need for a
    /// complete Unity common-strings table (some field names come back
    /// from the parser as `"common@<offset>"` placeholders).
    Seq(Vec<Value>),
}

// ---------------------------------------------------------------------------
// Writer — walks a node tree alongside a Value graph, emitting bytes.
// ---------------------------------------------------------------------------

pub struct TypeTreeWriter<'a> {
    nodes: &'a [TypeTreeNode],
    out: Vec<u8>,
}

impl<'a> TypeTreeWriter<'a> {
    pub fn new(nodes: &'a [TypeTreeNode]) -> Self {
        Self {
            nodes,
            out: Vec::new(),
        }
    }

    pub fn finish(self) -> Vec<u8> {
        self.out
    }

    /// Walk the tree starting at root node 0 against the value, emit
    /// the serialised bytes.
    pub fn write_root(&mut self, value: &Value) -> Result<(), SerializeError> {
        if self.nodes.is_empty() {
            return Err(SerializeError::Format("empty TypeTree".into()));
        }
        self.write_node(0, value)
    }

    fn write_node(&mut self, node_idx: usize, value: &Value) -> Result<(), SerializeError> {
        let node = &self.nodes[node_idx];

        // Type names from production TypeTrees often come back as
        // `"common@<offset>"` placeholders because our common-strings
        // table is partial. Rather than depending on the type-name
        // string, dispatch on (byte_size, children_count, value
        // variant) — these uniquely determine the wire format. This
        // also makes the walker robust to type-name aliasing (Unity
        // sometimes uses "int" vs "SInt32" vs "common@222" for the
        // same logical field).
        let is_leaf = node.children.is_empty();
        let size = node.byte_size;

        match (is_leaf, size, value) {
            // Primitive leaves — dispatch on byte_size.
            (true, 1, Value::Bool(_)) => self.write_bool(value)?,
            (true, 1, Value::I8(_)) => self.write_i8(value)?,
            (true, 1, Value::U8(_)) => self.write_u8(value)?,
            (true, 2, Value::I16(_)) => self.write_i16(value)?,
            (true, 2, Value::U16(_)) => self.write_u16(value)?,
            (true, 4, Value::I32(_)) => self.write_i32(value)?,
            (true, 4, Value::U32(_)) => self.write_u32(value)?,
            (true, 4, Value::F32(_)) => self.write_f32(value)?,
            (true, 8, Value::I64(_)) => self.write_i64(value)?,
            (true, 8, Value::U64(_)) => self.write_u64(value)?,
            (true, 8, Value::F64(_)) => self.write_f64(value)?,
            // Variable-length composites: distinguish by Value variant.
            // Unity wraps `string` and TypelessData in a 1-child
            // structural wrapper whose inner child carries the
            // alignment flag. Descend through the wrapper so the inner
            // node's ALIGN_BYTES is applied AFTER the write.
            (_, _, Value::String(_)) if node.children.len() == 1 => {
                let child_idx = node.children[0];
                return self.write_node(child_idx, value);
            }
            (_, _, Value::String(_)) => self.write_string_node(node_idx, value)?,
            (_, _, Value::Bytes(_)) if node.children.len() == 1 => {
                let child_idx = node.children[0];
                return self.write_node(child_idx, value);
            }
            (_, _, Value::Bytes(_)) => self.write_typeless(value)?,
            // Array container with explicit element values. Unity wraps
            // Array<T> nodes in a structural wrapper that has ONE child
            // (the actual size+data Array). When we land on the wrapper
            // (children=1) with Value::Array, descend into the child
            // before emitting; the child is the real Array with 2
            // children (size + data element type).
            (_, _, Value::Array(_)) if node.children.len() == 1 => {
                let child_idx = node.children[0];
                return self.write_node(child_idx, value);
                // (Skip the post-write ALIGN — alignment, if any, lives
                // on the inner child, not the wrapper.)
            }
            (_, _, Value::Array(_)) => self.write_array_node(node_idx, value)?,
            // Struct / fixed-size composite — recurse positionally
            // (Seq) or by name (Struct).
            (false, _, Value::Seq(_)) | (false, _, Value::Struct(_)) => {
                self.write_struct_node(node_idx, value)?
            }
            _ => {
                return Err(SerializeError::Format(format!(
                    "no write dispatch for node {node_idx} (type=\"{}\", name=\"{}\", \
                     byte_size={size}, children={}, value={value:?})",
                    node.type_name,
                    node.name,
                    node.children.len()
                )));
            }
        }

        // Apply ALIGN_BYTES after the field is written. The flag lives
        // on the node itself — child nodes inherit nothing; each is
        // checked independently.
        if node.meta_flag & flags::ALIGN_BYTES != 0 {
            self.align_to_4();
        }

        Ok(())
    }

    fn write_struct_node(&mut self, node_idx: usize, value: &Value) -> Result<(), SerializeError> {
        let child_indices = self.nodes[node_idx].children.clone();
        match value {
            Value::Struct(map) => {
                for child_idx in &child_indices {
                    let child_name = self.nodes[*child_idx].name.clone();
                    let child_value = map.get(&child_name).ok_or_else(|| {
                        SerializeError::Format(format!(
                            "struct value missing field \"{child_name}\" expected by TypeTree at node {node_idx}"
                        ))
                    })?;
                    self.write_node(*child_idx, child_value)?;
                }
                Ok(())
            }
            Value::Seq(items) => {
                if items.len() != child_indices.len() {
                    return Err(SerializeError::Format(format!(
                        "Seq value length {} != TypeTree children count {} at node {} (type {})",
                        items.len(),
                        child_indices.len(),
                        node_idx,
                        self.nodes[node_idx].type_name
                    )));
                }
                for (child_idx, item) in child_indices.iter().zip(items.iter()) {
                    self.write_node(*child_idx, item)?;
                }
                Ok(())
            }
            _ => Err(SerializeError::Format(format!(
                "expected Struct or Seq for TypeTree node \"{}\" (type {}), got {value:?}",
                self.nodes[node_idx].name, self.nodes[node_idx].type_name
            ))),
        }
    }

    /// `Array` container — child[0] is the size (i32), child[1] is the
    /// element type. We emit the size, then each element via the element
    /// child node.
    fn write_array_node(&mut self, node_idx: usize, value: &Value) -> Result<(), SerializeError> {
        let Value::Array(items) = value else {
            return Err(SerializeError::Format(format!(
                "expected array value for TypeTree node \"{}\", got {value:?}",
                self.nodes[node_idx].name
            )));
        };
        let elem_child = self.nodes[node_idx].children[1];
        self.write_u32_le_raw(items.len() as u32);
        for item in items {
            self.write_node(elem_child, item)?;
        }
        Ok(())
    }

    fn write_string_node(&mut self, _node_idx: usize, value: &Value) -> Result<(), SerializeError> {
        let Value::String(s) = value else {
            return Err(SerializeError::Format(format!(
                "expected string value, got {value:?}"
            )));
        };
        let bytes = s.as_bytes();
        self.write_u32_le_raw(bytes.len() as u32);
        self.out.extend_from_slice(bytes);
        // Strings in TypeTrees always carry the ALIGN_BYTES flag in
        // production; the outer write_node loop will apply alignment.
        Ok(())
    }

    fn write_typeless(&mut self, value: &Value) -> Result<(), SerializeError> {
        let Value::Bytes(b) = value else {
            return Err(SerializeError::Format(format!(
                "expected bytes value for TypelessData, got {value:?}"
            )));
        };
        self.write_u32_le_raw(b.len() as u32);
        self.out.extend_from_slice(b);
        Ok(())
    }

    fn align_to_4(&mut self) {
        let pad = (4 - (self.out.len() % 4)) % 4;
        for _ in 0..pad {
            self.out.push(0);
        }
    }

    fn write_u32_le_raw(&mut self, v: u32) {
        self.out.extend_from_slice(&v.to_le_bytes());
    }

    fn write_bool(&mut self, v: &Value) -> Result<(), SerializeError> {
        match v {
            Value::Bool(b) => {
                self.out.push(if *b { 1 } else { 0 });
                Ok(())
            }
            _ => Err(SerializeError::Format(format!("expected bool, got {v:?}"))),
        }
    }
    fn write_i8(&mut self, v: &Value) -> Result<(), SerializeError> {
        match v {
            Value::I8(x) => {
                self.out.push(*x as u8);
                Ok(())
            }
            _ => Err(SerializeError::Format(format!("expected i8, got {v:?}"))),
        }
    }
    fn write_u8(&mut self, v: &Value) -> Result<(), SerializeError> {
        match v {
            Value::U8(x) => {
                self.out.push(*x);
                Ok(())
            }
            _ => Err(SerializeError::Format(format!("expected u8, got {v:?}"))),
        }
    }
    fn write_i16(&mut self, v: &Value) -> Result<(), SerializeError> {
        match v {
            Value::I16(x) => {
                self.out.extend_from_slice(&x.to_le_bytes());
                Ok(())
            }
            _ => Err(SerializeError::Format(format!("expected i16, got {v:?}"))),
        }
    }
    fn write_u16(&mut self, v: &Value) -> Result<(), SerializeError> {
        match v {
            Value::U16(x) => {
                self.out.extend_from_slice(&x.to_le_bytes());
                Ok(())
            }
            _ => Err(SerializeError::Format(format!("expected u16, got {v:?}"))),
        }
    }
    fn write_i32(&mut self, v: &Value) -> Result<(), SerializeError> {
        match v {
            Value::I32(x) => {
                self.out.extend_from_slice(&x.to_le_bytes());
                Ok(())
            }
            _ => Err(SerializeError::Format(format!("expected i32, got {v:?}"))),
        }
    }
    fn write_u32(&mut self, v: &Value) -> Result<(), SerializeError> {
        match v {
            Value::U32(x) => {
                self.out.extend_from_slice(&x.to_le_bytes());
                Ok(())
            }
            _ => Err(SerializeError::Format(format!("expected u32, got {v:?}"))),
        }
    }
    fn write_i64(&mut self, v: &Value) -> Result<(), SerializeError> {
        match v {
            Value::I64(x) => {
                self.out.extend_from_slice(&x.to_le_bytes());
                Ok(())
            }
            _ => Err(SerializeError::Format(format!("expected i64, got {v:?}"))),
        }
    }
    fn write_u64(&mut self, v: &Value) -> Result<(), SerializeError> {
        match v {
            Value::U64(x) => {
                self.out.extend_from_slice(&x.to_le_bytes());
                Ok(())
            }
            _ => Err(SerializeError::Format(format!("expected u64, got {v:?}"))),
        }
    }
    fn write_f32(&mut self, v: &Value) -> Result<(), SerializeError> {
        match v {
            Value::F32(x) => {
                self.out.extend_from_slice(&x.to_le_bytes());
                Ok(())
            }
            _ => Err(SerializeError::Format(format!("expected f32, got {v:?}"))),
        }
    }
    fn write_f64(&mut self, v: &Value) -> Result<(), SerializeError> {
        match v {
            Value::F64(x) => {
                self.out.extend_from_slice(&x.to_le_bytes());
                Ok(())
            }
            _ => Err(SerializeError::Format(format!("expected f64, got {v:?}"))),
        }
    }
}

// ---------------------------------------------------------------------------
// TypeTreeReader — the inverse of TypeTreeWriter. Walks a TypeTree against
// a byte buffer and produces a `Value` tree. Mirrors the writer's dispatch
// and alignment decisions exactly so that `write(read(bytes)) == bytes`
// for any class. This is what the `verify-roundtrip` binary uses to
// confirm the writer reproduces real Unity object bytes for arbitrary
// classes without per-class hand-parsing.
//
// Key design choices that keep it byte-exact with the writer:
//   * Leaves are read as unsigned by byte_size (U8/U16/U32/U64). The
//     writer emits these as raw LE bytes regardless of int/float
//     interpretation, so the round-trip is exact without distinguishing
//     float vs int.
//   * 1-byte-element arrays (strings AND TypelessData) are read as
//     `Value::Bytes` (raw, no UTF-8 interpretation) — both write back
//     via the identical `u32 len + raw bytes` wire format, so binary
//     payloads (texture image data) survive intact.
//   * Wrapper descent + alignment exactly mirror the writer: a 1-child
//     wrapper whose child is an Array descends without applying the
//     outer node's align (the writer's early-return path).
pub struct TypeTreeReader<'a> {
    nodes: &'a [TypeTreeNode],
    buf: &'a [u8],
    pos: usize,
}

impl<'a> TypeTreeReader<'a> {
    pub fn new(nodes: &'a [TypeTreeNode], buf: &'a [u8]) -> Self {
        Self { nodes, buf, pos: 0 }
    }

    /// Bytes consumed so far — callers compare against the object size to
    /// confirm the walk landed exactly on the boundary.
    pub fn position(&self) -> usize {
        self.pos
    }

    pub fn read_root(&mut self) -> Result<Value, SerializeError> {
        if self.nodes.is_empty() {
            return Err(SerializeError::Format("empty TypeTree".into()));
        }
        self.read_node(0)
    }

    fn read_node(&mut self, node_idx: usize) -> Result<Value, SerializeError> {
        let node = &self.nodes[node_idx];

        // Wrapper descent: a 1-child node whose child is an Array. Mirrors
        // the writer's `return write_node(child)` early-return — the outer
        // node's align is NOT applied here; the inner Array node handles
        // its own.
        if node.children.len() == 1 && self.nodes[node.children[0]].is_array {
            return self.read_node(node.children[0]);
        }

        let value = if node.children.is_empty() {
            // Leaf — read byte_size bytes.
            let sz = node.byte_size.max(0) as usize;
            let raw = self.take(sz)?;
            match sz {
                1 => Value::U8(raw[0]),
                2 => Value::U16(u16::from_le_bytes(raw.try_into().unwrap())),
                4 => Value::U32(u32::from_le_bytes(raw.try_into().unwrap())),
                8 => Value::U64(u64::from_le_bytes(raw.try_into().unwrap())),
                other => {
                    return Err(SerializeError::Format(format!(
                        "leaf node {node_idx} has unsupported byte_size {other}"
                    )))
                }
            }
        } else if node.is_array {
            // Array container: child[0]=size (i32), child[1]=element.
            let count = u32::from_le_bytes(self.take(4)?.try_into().unwrap()) as usize;
            let elem_idx = node.children[1];
            let elem = &self.nodes[elem_idx];
            if elem.children.is_empty() && elem.byte_size == 1 {
                // 1-byte element → string or TypelessData. Read raw bytes
                // as Value::Bytes (writer's write_typeless reproduces the
                // exact same u32-len + raw-bytes wire format).
                let bytes = self.take(count)?.to_vec();
                Value::Bytes(bytes)
            } else {
                let mut items = Vec::with_capacity(count);
                for _ in 0..count {
                    items.push(self.read_node(elem_idx)?);
                }
                Value::Array(items)
            }
        } else {
            // Struct — positional Seq of children.
            let kids = node.children.clone();
            let mut items = Vec::with_capacity(kids.len());
            for k in kids {
                items.push(self.read_node(k)?);
            }
            Value::Seq(items)
        };

        // Apply ALIGN_BYTES after the field (mirrors the writer).
        if node.meta_flag & flags::ALIGN_BYTES != 0 {
            self.align_to_4();
        }

        Ok(value)
    }

    fn take(&mut self, n: usize) -> Result<&'a [u8], SerializeError> {
        if self.pos + n > self.buf.len() {
            return Err(SerializeError::Format(format!(
                "TypeTreeReader read past end: pos={} + {n} > {}",
                self.pos,
                self.buf.len()
            )));
        }
        let s = &self.buf[self.pos..self.pos + n];
        self.pos += n;
        Ok(s)
    }

    fn align_to_4(&mut self) {
        let pad = (4 - (self.pos % 4)) % 4;
        self.pos += pad;
    }
}

// ---------------------------------------------------------------------------
// Tests — hand-built trees verify the walker. Real-Unity-TypeTree tests
// land once a fixture binary is committed at
// encoder/baked-fixtures/typetrees/<unity_version>.bin.
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeMap;

    fn node(level: u8, name: &str, type_name: &str, meta_flag: u32) -> TypeTreeNode {
        // byte_size is computed from type_name for hand-built test nodes.
        // The walker dispatches on (byte_size, children, value variant)
        // so getting the size right matters for tests to drive the
        // right primitive branch.
        let byte_size = match type_name {
            "bool" | "SInt8" | "UInt8" | "char" => 1,
            "SInt16" | "UInt16" | "short" => 2,
            "SInt32" | "UInt32" | "int" | "unsigned int" | "float" => 4,
            "SInt64" | "UInt64" | "long long" | "double" => 8,
            // Variable-length / aggregates.
            _ => -1,
        };
        TypeTreeNode {
            level,
            name: name.into(),
            type_name: type_name.into(),
            byte_size,
            index: 0,
            meta_flag,
            is_array: false,
            children: Vec::new(),
        }
    }

    /// Helper — build a children list from a flat node array using the
    /// level field (mirrors what parse_type_tree_nodes does).
    fn wire_children(nodes: &mut [TypeTreeNode]) {
        let mut stack: Vec<usize> = Vec::new();
        for i in 0..nodes.len() {
            let level = nodes[i].level as usize;
            while stack.len() > level {
                stack.pop();
            }
            if let Some(&parent) = stack.last() {
                nodes[parent].children.push(i);
            }
            stack.push(i);
        }
    }

    #[test]
    fn writes_primitive_struct() {
        // class Foo { int x; float y; bool z; }
        let mut tree = vec![
            node(0, "Base", "Foo", 0),
            node(1, "x", "int", 0),
            node(1, "y", "float", 0),
            node(1, "z", "bool", 0),
        ];
        wire_children(&mut tree);

        let mut value = BTreeMap::new();
        value.insert("x".into(), Value::I32(42));
        value.insert("y".into(), Value::F32(3.5));
        value.insert("z".into(), Value::Bool(true));

        let mut w = TypeTreeWriter::new(&tree);
        w.write_root(&Value::Struct(value)).unwrap();
        let bytes = w.finish();

        // 4 bytes int + 4 bytes float + 1 byte bool = 9 bytes (no
        // alignment because no node has ALIGN_BYTES).
        assert_eq!(bytes.len(), 9);
        assert_eq!(i32::from_le_bytes(bytes[0..4].try_into().unwrap()), 42);
        assert_eq!(f32::from_le_bytes(bytes[4..8].try_into().unwrap()), 3.5);
        assert_eq!(bytes[8], 1);
    }

    #[test]
    fn applies_align_bytes_after_string() {
        // class Foo { string s; int after; }
        // Unity-emitted "string" nodes always carry ALIGN_BYTES so the
        // following field starts 4-byte aligned. Verify the walker pads
        // correctly.
        let mut tree = vec![
            node(0, "Base", "Foo", 0),
            node(1, "s", "string", flags::ALIGN_BYTES),
            node(1, "after", "int", 0),
        ];
        wire_children(&mut tree);

        let mut value = BTreeMap::new();
        value.insert("s".into(), Value::String("hi".into())); // 2 bytes after length prefix
        value.insert("after".into(), Value::I32(0xdeadbeefu32 as i32));

        let mut w = TypeTreeWriter::new(&tree);
        w.write_root(&Value::Struct(value)).unwrap();
        let bytes = w.finish();

        // Layout:
        //   bytes 0..4  : u32 length = 2
        //   bytes 4..6  : "hi"
        //   bytes 6..8  : 2 bytes of padding (align to 4)
        //   bytes 8..12 : i32 0xdeadbeef
        assert_eq!(bytes.len(), 12);
        assert_eq!(u32::from_le_bytes(bytes[0..4].try_into().unwrap()), 2);
        assert_eq!(&bytes[4..6], b"hi");
        assert_eq!(&bytes[6..8], &[0, 0]);
        assert_eq!(
            i32::from_le_bytes(bytes[8..12].try_into().unwrap()),
            0xdeadbeefu32 as i32
        );
    }

    #[test]
    fn writes_array_of_primitives() {
        // class Foo { Array<int> nums; }  ← Unity Array container shape
        let mut tree = vec![
            node(0, "Base", "Foo", 0),
            node(1, "nums", "Array", 0), // Array container
            node(2, "size", "int", 0),   // first child: size
            node(2, "data", "int", 0),   // second child: element type
        ];
        wire_children(&mut tree);

        let mut value = BTreeMap::new();
        value.insert(
            "nums".into(),
            Value::Array(vec![Value::I32(10), Value::I32(20), Value::I32(30)]),
        );

        let mut w = TypeTreeWriter::new(&tree);
        w.write_root(&Value::Struct(value)).unwrap();
        let bytes = w.finish();

        // 4 bytes len + 3 * 4 bytes int = 16
        assert_eq!(bytes.len(), 16);
        assert_eq!(u32::from_le_bytes(bytes[0..4].try_into().unwrap()), 3);
        assert_eq!(i32::from_le_bytes(bytes[4..8].try_into().unwrap()), 10);
        assert_eq!(i32::from_le_bytes(bytes[8..12].try_into().unwrap()), 20);
        assert_eq!(i32::from_le_bytes(bytes[12..16].try_into().unwrap()), 30);
    }

    #[test]
    fn rejects_struct_with_missing_field() {
        let mut tree = vec![
            node(0, "Base", "Foo", 0),
            node(1, "expected", "int", 0),
        ];
        wire_children(&mut tree);

        let value = Value::Struct(BTreeMap::new()); // empty — missing "expected"

        let mut w = TypeTreeWriter::new(&tree);
        let err = w.write_root(&value).unwrap_err();
        assert!(matches!(err, SerializeError::Format(_)));
    }

    #[test]
    fn parser_round_trips_a_handbuilt_blob() {
        // Build a minimal blob: 1 node, no children, no string-buffer
        // entries (use a common-string index for the name + type).
        let mut blob = Vec::new();
        blob.extend_from_slice(&1u32.to_le_bytes()); // node_count
        blob.extend_from_slice(&0u32.to_le_bytes()); // string_buffer_size
        // Node record:
        blob.extend_from_slice(&0u16.to_le_bytes()); // version
        blob.push(0); // level
        blob.push(0); // is_array
        // type = "GameObject" (common string idx 21), high bit set
        blob.extend_from_slice(&(0x80000000u32 | 21).to_le_bytes());
        // name = "Base" (common string idx 6), high bit set
        blob.extend_from_slice(&(0x80000000u32 | 6).to_le_bytes());
        blob.extend_from_slice(&0i32.to_le_bytes()); // byte_size
        blob.extend_from_slice(&0i32.to_le_bytes()); // index
        blob.extend_from_slice(&0u32.to_le_bytes()); // meta_flag
        blob.extend_from_slice(&0u64.to_le_bytes()); // ref_type_hash

        let nodes = parse_type_tree_nodes(&blob).unwrap();
        assert_eq!(nodes.len(), 1);
        assert_eq!(nodes[0].name, "Base");
        assert_eq!(nodes[0].type_name, "GameObject");
    }

    #[test]
    fn reader_writer_round_trip_handbuilt() {
        // class Foo { int x; string s; Array<int> nums; }
        // Reader reads a Value from raw bytes, Writer writes it back —
        // the two must be mutual inverses for any tree. This is the
        // property the verify-roundtrip binary relies on at scale.
        let mut tree = vec![
            node(0, "Base", "Foo", 0),
            node(1, "x", "int", 0),
            node(1, "s", "string", 0),
            node(2, "Array", "Array", flags::ALIGN_BYTES),
            node(3, "size", "int", 0),
            node(3, "data", "char", 0),
            node(1, "nums", "Array", 0),
            node(2, "Array", "Array", 0),
            node(3, "size", "int", 0),
            node(3, "data", "int", 0),
        ];
        // Mark the two Array container nodes (indices 3 and 7).
        tree[3].is_array = true;
        tree[7].is_array = true;
        wire_children(&mut tree);

        // Hand-assemble bytes: x=7, s="hi" (4-len + 2 bytes + 2 pad),
        // nums=[10,20].
        let mut bytes = Vec::new();
        bytes.extend_from_slice(&7i32.to_le_bytes()); // x
        bytes.extend_from_slice(&2u32.to_le_bytes()); // s len
        bytes.extend_from_slice(b"hi"); // s data
        bytes.extend_from_slice(&[0, 0]); // align to 4
        bytes.extend_from_slice(&2u32.to_le_bytes()); // nums count
        bytes.extend_from_slice(&10i32.to_le_bytes());
        bytes.extend_from_slice(&20i32.to_le_bytes());

        let mut reader = TypeTreeReader::new(&tree, &bytes);
        let value = reader.read_root().unwrap();
        assert_eq!(reader.position(), bytes.len(), "read must consume all bytes");

        let mut writer = TypeTreeWriter::new(&tree);
        writer.write_root(&value).unwrap();
        let out = writer.finish();
        assert_eq!(out, bytes, "writer(reader(bytes)) must equal bytes");
    }
}
