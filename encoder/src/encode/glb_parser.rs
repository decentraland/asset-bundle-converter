//! glTF / glb dependency parser.
//!
//! Mirrors the TS-side parser at
//! `consumer-server/src/logic/gltf-deps.ts:1-181` semantics exactly. The
//! same scenes pass through both parsers during rollout (the digester runs
//! before the encoder is even invoked) — divergence would surface as
//! "encoder sees a dep that the digest didn't" or vice versa, which would
//! mis-route the bundle naming.
//!
//! Spec reference (cited in the TS source too):
//! https://registry.khronos.org/glTF/specs/2.0/glTF-2.0.html#binary-gltf-layout
//!
//! What's deliberately NOT in this module: the full glTF document model
//! (nodes, meshes, materials). That's what `mesh.rs` and `material.rs` will
//! handle — they'll use the `gltf` crate once they need it, but the dep
//! extraction here doesn't, to stay byte-identical to the TS digester.

use serde::Deserialize;
use thiserror::Error;

// glb 2.0 binary container constants — same names as gltf-deps.ts:9-12.
const GLB_MAGIC: u32 = 0x4654_6c67; // "glTF" LE
const GLB_CHUNK_TYPE_JSON: u32 = 0x4e4f_534a; // "JSON" LE
const GLB_HEADER_BYTES: usize = 12;
const GLB_CHUNK_HEADER_BYTES: usize = 8;

#[derive(Debug, Error)]
pub enum GltfParseError {
    #[error("{0}")]
    Structural(String),
    #[error("glTF JSON parse failed: {0}")]
    Json(String),
    #[error("glTF URI \"{uri}\": {reason}")]
    Uri { uri: String, reason: String },
}

/// Glb container variant — `.glb` carries binary chunks, `.gltf` is plain
/// UTF-8 JSON. Mirrors the TS-side `ext: '.glb' | '.gltf'` discriminator.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GltfFlavor {
    Glb,
    Gltf,
}

#[derive(Debug, Deserialize)]
struct GltfJsonRoot {
    #[serde(default)]
    images: Vec<GltfUriHolder>,
    #[serde(default)]
    buffers: Vec<GltfUriHolder>,
}

#[derive(Debug, Deserialize)]
struct GltfUriHolder {
    #[serde(default)]
    uri: Option<String>,
}

/// Extract the JSON portion from a glb byte buffer, or return the bytes
/// as-is for a `.gltf`. Validates magic + version + chunk header.
///
/// Mirrors `extractGltfJson` at gltf-deps.ts:28-66 including the trailing
/// padding strip (null bytes and ASCII whitespace) that tolerates older
/// Blender / DCC plugins that pad with `0x00` instead of `0x20`.
pub fn extract_gltf_json(bytes: &[u8], flavor: GltfFlavor) -> Result<String, GltfParseError> {
    if flavor == GltfFlavor::Gltf {
        return std::str::from_utf8(bytes)
            .map(|s| s.to_string())
            .map_err(|e| GltfParseError::Structural(format!("gltf not valid UTF-8: {e}")));
    }

    if bytes.len() < GLB_HEADER_BYTES + GLB_CHUNK_HEADER_BYTES {
        return Err(GltfParseError::Structural(format!(
            "glb too short: {} bytes",
            bytes.len()
        )));
    }

    // Little-endian u32 reads at offsets 0/4/8 (magic/version/total) and
    // 12/16 (chunk0 length + type). gltf-deps.ts uses readUInt32LE — same
    // wire order.
    let magic = u32::from_le_bytes(bytes[0..4].try_into().expect("4 bytes"));
    if magic != GLB_MAGIC {
        return Err(GltfParseError::Structural(format!(
            "glb magic mismatch: expected 0x{GLB_MAGIC:x}, got 0x{magic:x}"
        )));
    }
    let version = u32::from_le_bytes(bytes[4..8].try_into().expect("4 bytes"));
    if version != 2 {
        return Err(GltfParseError::Structural(format!(
            "unsupported glb version: {version} (only glTF 2.0 is supported)"
        )));
    }

    let chunk_length =
        u32::from_le_bytes(bytes[GLB_HEADER_BYTES..GLB_HEADER_BYTES + 4].try_into().expect("4")) as usize;
    let chunk_type = u32::from_le_bytes(
        bytes[GLB_HEADER_BYTES + 4..GLB_HEADER_BYTES + 8]
            .try_into()
            .expect("4"),
    );
    if chunk_type != GLB_CHUNK_TYPE_JSON {
        return Err(GltfParseError::Structural(format!(
            "glb first chunk is not JSON (type 0x{chunk_type:x})"
        )));
    }

    let json_start = GLB_HEADER_BYTES + GLB_CHUNK_HEADER_BYTES;
    let json_end = json_start
        .checked_add(chunk_length)
        .ok_or_else(|| GltfParseError::Structural("glb chunk length overflows usize".into()))?;
    if json_end > bytes.len() {
        return Err(GltfParseError::Structural(format!(
            "glb JSON chunk ({chunk_length} bytes) overruns buffer ({} bytes)",
            bytes.len()
        )));
    }

    // Same trailing-padding strip as gltf-deps.ts:59-64 — tolerates both
    // 0x20-padded (spec) and 0x00-padded (some exporters) chunks plus the
    // four standard ASCII whitespaces.
    let mut end = json_end;
    while end > json_start {
        let b = bytes[end - 1];
        if b == 0x00 || b == 0x20 || b == 0x09 || b == 0x0a || b == 0x0d {
            end -= 1;
        } else {
            break;
        }
    }

    std::str::from_utf8(&bytes[json_start..end])
        .map(|s| s.to_string())
        .map_err(|e| GltfParseError::Structural(format!("glb JSON not valid UTF-8: {e}")))
}

/// Deduplicated, ASCIIbetically-sorted list of external URIs from a
/// glb/gltf buffer. Mirrors `parseGltfDepRefs` at gltf-deps.ts:85-120.
///
/// Order-invariance is load-bearing: the encoder feeds these into the
/// per-asset digest computation indirectly (via the contentMap lookup),
/// and the digester on the TS side sorts the same way. Two encodings of
/// the same scene must produce the same digest, regardless of glTF JSON
/// key order.
pub fn parse_dep_uris(bytes: &[u8], flavor: GltfFlavor) -> Result<Vec<String>, GltfParseError> {
    let json_text = extract_gltf_json(bytes, flavor)?;

    // serde_json's `from_str` rejects non-object roots automatically (we'd
    // get a deserialization error trying to match the `GltfJsonRoot`
    // struct against a number or array). Matches the explicit guard at
    // gltf-deps.ts:98-100.
    let root: GltfJsonRoot =
        serde_json::from_str(&json_text).map_err(|e| GltfParseError::Json(e.to_string()))?;

    let mut set: std::collections::BTreeSet<String> = std::collections::BTreeSet::new();
    for holder in root.images.into_iter().chain(root.buffers.into_iter()) {
        // Same triage as gltf-deps.ts:106-114:
        //   - uri missing → embedded / bufferView-backed (skip)
        //   - uri starts with "data:" → inline base64 (not an external dep)
        //   - anything else → external dep
        let Some(uri) = holder.uri else { continue };
        if uri.starts_with("data:") {
            continue;
        }
        set.insert(uri);
    }

    // BTreeSet iteration is already sorted; just collect.
    Ok(set.into_iter().collect())
}

/// Resolve a relative glTF URI against the glb's filename to the
/// catalyst content-map key (a posix-style path relative to the entity
/// root). Mirrors `resolveUriToContentFile` at gltf-deps.ts:148-180.
///
/// `glb_file` is the lower-cased filename the glb is registered under in
/// the entity's content map — `posix::dirname(glb_file)` is the base for
/// the join. The returned string is what we look up in `contentMap` to
/// find the dep's CID.
pub fn resolve_uri(uri: &str, glb_file: &str) -> Result<String, GltfParseError> {
    if uri.is_empty() {
        return Err(GltfParseError::Uri {
            uri: uri.into(),
            reason: "URI is empty".into(),
        });
    }

    // Scheme check: leading letter + optional `[a-zA-Z0-9+.-]*` + `:`.
    // Same regex as gltf-deps.ts:152.
    if has_uri_scheme(uri) {
        return Err(GltfParseError::Uri {
            uri: uri.into(),
            reason: "has a URI scheme — only relative paths are supported".into(),
        });
    }
    if uri.starts_with("//") {
        return Err(GltfParseError::Uri {
            uri: uri.into(),
            reason: "is protocol-relative — only relative paths are supported".into(),
        });
    }
    if uri.starts_with('/') {
        return Err(GltfParseError::Uri {
            uri: uri.into(),
            reason: "is an absolute path — only relative paths are supported".into(),
        });
    }
    if uri.contains('?') || uri.contains('#') {
        return Err(GltfParseError::Uri {
            uri: uri.into(),
            reason: "contains a query/fragment component, which is not supported".into(),
        });
    }

    let decoded = percent_decode(uri).map_err(|reason| GltfParseError::Uri {
        uri: uri.into(),
        reason,
    })?;

    // Posix dirname of the glb file. "foo.glb" → ""; "models/foo.glb" → "models".
    // Matches `path.posix.dirname` semantics from gltf-deps.ts:172.
    let base = posix_dirname(glb_file);
    let joined = if base.is_empty() || base == "." {
        decoded
    } else {
        format!("{base}/{decoded}")
    };
    let normalized = posix_normalize(&joined);

    if normalized.starts_with("../") || normalized == ".." {
        return Err(GltfParseError::Uri {
            uri: uri.into(),
            reason: format!("escapes entity root (resolved to \"{normalized}\")"),
        });
    }

    Ok(normalized)
}

fn has_uri_scheme(uri: &str) -> bool {
    let mut chars = uri.chars();
    let Some(first) = chars.next() else { return false };
    if !first.is_ascii_alphabetic() {
        return false;
    }
    for c in chars {
        if c == ':' {
            return true;
        }
        if c.is_ascii_alphanumeric() || c == '+' || c == '.' || c == '-' {
            continue;
        }
        return false;
    }
    false
}

/// Strict percent-decoding: matches JS `decodeURIComponent`. Rejects any
/// `%XX` where XX isn't valid hex or decodes to invalid UTF-8.
fn percent_decode(s: &str) -> Result<String, String> {
    let mut out = Vec::with_capacity(s.len());
    let bytes = s.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            if i + 2 >= bytes.len() {
                return Err(format!("invalid percent-encoding: truncated at position {i}"));
            }
            let hex = std::str::from_utf8(&bytes[i + 1..i + 3])
                .map_err(|_| format!("invalid percent-encoding: non-ASCII hex at position {i}"))?;
            let byte = u8::from_str_radix(hex, 16)
                .map_err(|_| format!("invalid percent-encoding: bad hex \"%{hex}\" at position {i}"))?;
            out.push(byte);
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8(out).map_err(|e| format!("not UTF-8 after decode: {e}"))
}

fn posix_dirname(p: &str) -> String {
    match p.rfind('/') {
        Some(idx) => p[..idx].to_string(),
        None => String::new(),
    }
}

/// Resolve `.` and `..` segments. Matches the subset of `path.posix.normalize`
/// we need — input is always a relative forward-slash path here, no double
/// slashes (single segment join above means at most one `/` between parts).
fn posix_normalize(p: &str) -> String {
    let mut out: Vec<&str> = Vec::new();
    for seg in p.split('/') {
        match seg {
            "" | "." => continue,
            ".." => {
                if out.last().map(|s| *s != "..").unwrap_or(false) {
                    out.pop();
                } else {
                    out.push("..");
                }
            }
            other => out.push(other),
        }
    }
    if out.is_empty() {
        ".".into()
    } else {
        out.join("/")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_glb(json: &str) -> Vec<u8> {
        // Pad JSON to 4-byte alignment with spaces (spec form). Glb total
        // size: 12 (header) + 8 (chunk header) + padded JSON length.
        let mut padded = json.as_bytes().to_vec();
        while padded.len() % 4 != 0 {
            padded.push(0x20);
        }
        let chunk_length = padded.len() as u32;
        let total = (GLB_HEADER_BYTES + GLB_CHUNK_HEADER_BYTES + padded.len()) as u32;

        let mut out = Vec::with_capacity(total as usize);
        out.extend_from_slice(&GLB_MAGIC.to_le_bytes());
        out.extend_from_slice(&2u32.to_le_bytes());
        out.extend_from_slice(&total.to_le_bytes());
        out.extend_from_slice(&chunk_length.to_le_bytes());
        out.extend_from_slice(&GLB_CHUNK_TYPE_JSON.to_le_bytes());
        out.extend_from_slice(&padded);
        out
    }

    #[test]
    fn extracts_uris_from_glb() {
        let json = r#"{"images":[{"uri":"tex.png"},{"uri":"data:image/png;base64,xxx"}],"buffers":[{"uri":"data.bin"}]}"#;
        let bytes = make_glb(json);
        let uris = parse_dep_uris(&bytes, GltfFlavor::Glb).unwrap();
        // Sorted, dedup'd, data: filtered out.
        assert_eq!(uris, vec!["data.bin".to_string(), "tex.png".to_string()]);
    }

    #[test]
    fn rejects_wrong_magic() {
        let mut bytes = make_glb("{}");
        bytes[0] = 0xAA;
        let err = parse_dep_uris(&bytes, GltfFlavor::Glb).unwrap_err();
        assert!(matches!(err, GltfParseError::Structural(_)));
    }

    #[test]
    fn rejects_v1_glb() {
        let json = r#"{}"#;
        let mut bytes = make_glb(json);
        // Overwrite version field at offset 4 with 1.
        bytes[4..8].copy_from_slice(&1u32.to_le_bytes());
        let err = parse_dep_uris(&bytes, GltfFlavor::Glb).unwrap_err();
        assert!(matches!(err, GltfParseError::Structural(_)));
    }

    #[test]
    fn handles_null_padding() {
        // Some exporters pad with 0x00 instead of 0x20 — TS side tolerates
        // it, so do we.
        let mut bytes = make_glb(r#"{"buffers":[{"uri":"x.bin"}]}"#);
        // Replace trailing spaces (if any) with 0x00.
        let len = bytes.len();
        for b in bytes[len - 3..].iter_mut() {
            if *b == 0x20 {
                *b = 0x00;
            }
        }
        let uris = parse_dep_uris(&bytes, GltfFlavor::Glb).unwrap();
        assert_eq!(uris, vec!["x.bin".to_string()]);
    }

    #[test]
    fn parses_gltf_text() {
        let json = r#"{"images":[{"uri":"a.png"}],"buffers":[{"uri":"a.bin"}]}"#;
        let uris = parse_dep_uris(json.as_bytes(), GltfFlavor::Gltf).unwrap();
        assert_eq!(uris, vec!["a.bin".to_string(), "a.png".to_string()]);
    }

    #[test]
    fn resolves_relative_uri() {
        assert_eq!(resolve_uri("tex.png", "model.glb").unwrap(), "tex.png");
        assert_eq!(
            resolve_uri("textures/tex.png", "models/model.glb").unwrap(),
            "models/textures/tex.png"
        );
        assert_eq!(
            resolve_uri("../shared/tex.png", "models/foo/m.glb").unwrap(),
            "models/shared/tex.png"
        );
    }

    #[test]
    fn percent_decodes_uri() {
        assert_eq!(
            resolve_uri("with%20space.png", "m.glb").unwrap(),
            "with space.png"
        );
    }

    #[test]
    fn rejects_uri_scheme() {
        let err = resolve_uri("https://example.com/x.png", "m.glb").unwrap_err();
        assert!(matches!(err, GltfParseError::Uri { .. }));
    }

    #[test]
    fn rejects_absolute_path() {
        assert!(matches!(
            resolve_uri("/x.png", "m.glb").unwrap_err(),
            GltfParseError::Uri { .. }
        ));
    }

    #[test]
    fn rejects_escape_above_root() {
        assert!(matches!(
            resolve_uri("../../escape.png", "m.glb").unwrap_err(),
            GltfParseError::Uri { .. }
        ));
    }

    #[test]
    fn rejects_query_fragment() {
        assert!(matches!(
            resolve_uri("x.png?v=1", "m.glb").unwrap_err(),
            GltfParseError::Uri { .. }
        ));
        assert!(matches!(
            resolve_uri("x.png#frag", "m.glb").unwrap_err(),
            GltfParseError::Uri { .. }
        ));
    }

    #[test]
    fn rejects_bad_percent_encoding() {
        assert!(matches!(
            resolve_uri("bad%ZZ.png", "m.glb").unwrap_err(),
            GltfParseError::Uri { .. }
        ));
    }
}
