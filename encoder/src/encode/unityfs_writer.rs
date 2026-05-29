//! UnityFS outer container writer.
//!
//! ⚠️ STATUS — spec-derived, NOT verified against a Unity-built reference
//! bundle. Format constants come from AssetRipper's read-side
//! implementation, the UnityPy source, and observed bundle behaviour.
//! Until a fixture is extracted and round-tripped through this writer
//! the output is "plausibly correct" rather than "byte-correct".
//!
//! What IS self-verifying:
//!   * LZ4 round-trip (compress → decompress yields original bytes).
//!   * Header round-trip (write then read by our own reader matches).
//!   * BlockInfo round-trip (write then read matches).
//!
//! What is NOT verified:
//!   * Whether Unity's loader accepts our header field ordering /
//!     endianness combinations.
//!   * Whether the flags bitfield value for "LZ4 chunked compression"
//!     is exactly `0x43` (compression bits + kBlocksAndDirectoryInfoCombined)
//!     or whether more bits matter.
//!   * The exact block-chunk size Unity expects (we use 128 KiB; readers
//!     accept any size, but writers diverge — verify against a fixture).
//!
//! Reference: github.com/AssetRipper/AssetRipper/tree/master/Source/AssetRipper.IO.Files/BundleFiles

use std::io::Write;

use lz4_flex::block;

use super::SerializeError;

// ---------------------------------------------------------------------------
// Format constants — values from AssetRipper's BundleFile reader.
// ---------------------------------------------------------------------------

/// 8-byte ASCII signature, null-terminated. Unity always emits exactly
/// this prefix for UnityFS bundles.
pub const SIGNATURE: &[u8; 8] = b"UnityFS\0";

/// Format version Unity emits in production bundles.
///
/// Verified against a real ab-cdn bundle (entity bafkreiaetz..., target
/// Windows): Unity uses format 8 for 2021.x AND 2022.x — older sources
/// (AssetRipper docs) reference 6, but live bundles use 8. The reader
/// accepts the range [6, 8]; the writer emits 8 to match Unity.
pub const FORMAT_VERSION: u32 = 8;

/// Lowest format version our reader accepts. Older bundles may exist
/// in long-tail caches; raising this rejects bundles older than the
/// floor.
pub const MIN_READER_FORMAT_VERSION: u32 = 6;

/// Highest format version our reader accepts.
pub const MAX_READER_FORMAT_VERSION: u32 = 8;

/// Legacy "Unity version" cstring stamp written BEFORE the actual
/// unity-revision. Always "5.x.x" per AssetRipper observation and
/// confirmed in real bundles (the byte sequence at offset 0x0C is
/// `35 2e 78 2e 78 00`). Earlier versions of this code had the field
/// order reversed; verified against a 2022.3.12f1 bundle that the
/// legacy field comes first.
pub const LEGACY_UNITY_VERSION: &str = "5.x.x";

/// Compression-flag values for the low 6 bits of the header `flags`
/// field. The same compression type applies to BOTH the BlockInfo
/// section AND the per-block data — there is no separate "BlockInfo is
/// compressed" bit. lz4_flex's `decompress` handles both LZ4 (2) and
/// LZ4HC (3) — they share a wire format and differ only in encoder
/// quality.
const COMPRESSION_NONE: u32 = 0x00;
#[allow(dead_code)]
const COMPRESSION_LZMA: u32 = 0x01;
const COMPRESSION_LZ4: u32 = 0x02;
const COMPRESSION_LZ4HC: u32 = 0x03;
const COMPRESSION_TYPE_MASK: u32 = 0x3f;

/// Header `flags` bit names per AssetRipper's `ArchiveFlags` enum.
/// Verified against real Unity 2022.3.x bundle (flags = 0x243 →
/// bits 0x40 + 0x200 + low-bits-3).
const FLAG_BLOCKS_AND_DIRECTORY_INFO_COMBINED: u32 = 0x40;
const FLAG_BLOCKS_INFO_AT_THE_END: u32 = 0x80;
#[allow(dead_code)]
const FLAG_OLD_WEB_PLUGIN_COMPATIBILITY: u32 = 0x100;
/// When set, the BlockInfo section starts at a 16-byte-aligned offset
/// (with zero-pad bytes between the header and BlockInfo to reach that
/// alignment). Real production bundles use this.
const FLAG_BLOCK_INFO_NEED_PADDING_AT_START: u32 = 0x200;

/// Conservative chunk size for the data block payload. Unity uses
/// 128 KiB. Readers accept any value; we pick this to match observed
/// production bundles.
pub const DATA_BLOCK_CHUNK_SIZE: usize = 128 * 1024;

/// Per-block flag emitted in the BlockInfo table entries.
///   * bit 0..5 = compression type (LZ4 = 2)
///   * bit 6    = block contains data we should stream-decompress
const BLOCK_FLAG_LZ4: u16 = 0x02;
#[allow(dead_code)]
const BLOCK_FLAG_NONE: u16 = 0x00;

/// Per-node directory flag emitted in BlockInfo's node table entries.
/// Bit 2 (0x04) marks the node as "Serialized File" (vs raw resource).
const NODE_FLAG_SERIALIZED_FILE: u32 = 0x04;

// ---------------------------------------------------------------------------
// Input types passed to the writer
// ---------------------------------------------------------------------------

/// One node entry in the bundle's directory — corresponds to one
/// SerializedFile (or raw resource) inside the UnityFS archive. Our
/// bundles always contain exactly one node (the SerializedFile that
/// carries the Mesh/Material/Texture2D etc. objects).
pub struct DirectoryNode {
    /// Path inside the archive. Unity emits the SerializedFile under
    /// the asset path "CAB-<32-hex>" by convention (CAB = Compressed
    /// Asset Bundle); the exact name doesn't matter for loading, but
    /// matching the convention keeps diagnostic tools happy.
    pub path: String,
    pub flags: u32,
    /// Payload bytes (uncompressed). Concatenated with other nodes'
    /// payloads into the bundle's data section before chunked LZ4
    /// compression.
    pub payload: Vec<u8>,
}

impl DirectoryNode {
    /// Convenience: build a SerializedFile node with a deterministic
    /// CAB-prefixed name. The hash is derived from the payload so reruns
    /// of the encoder over the same input produce byte-stable output.
    pub fn serialized_file(payload: Vec<u8>) -> Self {
        // Use a low-cost stable hash. We're not cryptographically signing
        // anything — Unity's CAB filename is informational. A 16-hex
        // digest is enough.
        let mut hash: u64 = 0xcbf29ce484222325; // FNV-1a 64
        for &b in &payload {
            hash ^= b as u64;
            hash = hash.wrapping_mul(0x100000001b3);
        }
        Self {
            path: format!("CAB-{:016x}", hash),
            flags: NODE_FLAG_SERIALIZED_FILE,
            payload,
        }
    }

    /// SerializedFile node with a caller-chosen CAB name. Used when a
    /// `.resS` sidecar must reference the SF's CAB name before the SF bytes
    /// exist (the name would otherwise be a content-hash → circular).
    pub fn serialized_file_named(cab_name: String, payload: Vec<u8>) -> Self {
        Self { path: cab_name, flags: NODE_FLAG_SERIALIZED_FILE, payload }
    }

    /// A raw resource node (e.g. a `.resS` streamed-texture sidecar). No
    /// SerializedFile flag — Unity treats it as opaque resource bytes.
    pub fn resource(name: String, payload: Vec<u8>) -> Self {
        Self { path: name, flags: 0, payload }
    }
}

pub struct UnityFsWriteOptions<'a> {
    /// The Unity revision string Unity stamps into the header (e.g.
    /// "2021.3.20f1"). Comes from `BakeInfo.unity_version`.
    pub unity_revision: &'a str,
    /// One or more directory nodes. Always 1 in our pipeline (one
    /// SerializedFile per bundle).
    pub nodes: Vec<DirectoryNode>,
}

// ---------------------------------------------------------------------------
// Header
// ---------------------------------------------------------------------------

/// Bytes-written cursor for the header. Public so tests in this module
/// AND the SerializedFile writer can use the same helpers.
pub(crate) fn write_u32_be<W: Write>(w: &mut W, v: u32) -> Result<(), SerializeError> {
    w.write_all(&v.to_be_bytes()).map_err(SerializeError::from)
}

pub(crate) fn write_i64_be<W: Write>(w: &mut W, v: i64) -> Result<(), SerializeError> {
    w.write_all(&v.to_be_bytes()).map_err(SerializeError::from)
}

pub(crate) fn write_cstring<W: Write>(w: &mut W, s: &str) -> Result<(), SerializeError> {
    if s.as_bytes().contains(&0) {
        return Err(SerializeError::Format(
            "cstring payload contains a null byte".into(),
        ));
    }
    w.write_all(s.as_bytes())?;
    w.write_all(&[0])?;
    Ok(())
}

/// Internal: write the fixed-prefix portion of the header (everything
/// before the size-dependent fields). Used by the main writer to lay
/// out the file in a single pass after sizes are computed.
fn write_header_prefix<W: Write>(w: &mut W, unity_revision: &str) -> Result<(), SerializeError> {
    // Field order verified against a real ab-cdn bundle (2022.3.12f1):
    //   1. "UnityFS\0"               (8 bytes)
    //   2. format_version u32 BE      (4 bytes)
    //   3. legacy "5.x.x\0"           (6 bytes)
    //   4. unity_revision cstring     (variable)
    // Earlier iterations had (3) and (4) swapped; the live bundle's
    // byte layout corrected the order.
    w.write_all(SIGNATURE)?;
    write_u32_be(w, FORMAT_VERSION)?;
    write_cstring(w, LEGACY_UNITY_VERSION)?;
    write_cstring(w, unity_revision)?;
    Ok(())
}

// ---------------------------------------------------------------------------
// BlockInfo + directory
// ---------------------------------------------------------------------------

/// Serialise the BlockInfoAndDirectory section.
///
/// Layout (mirrors AssetRipper.IO.Files BundleFile/BlockInfoAndDirectory):
///   * 16-byte uncompressed_hash — Unity zero-fills this for production
///     bundles. We do the same.
///   * u32 BE block count
///   * per block: u32 BE uncompressed_size, u32 BE compressed_size, u16 BE flags
///   * u32 BE node count
///   * per node: i64 BE offset, i64 BE size, u32 BE flags, cstring path
fn write_block_info_uncompressed(
    blocks: &[BlockEntry],
    nodes: &[NodeEntry],
) -> Result<Vec<u8>, SerializeError> {
    let mut out = Vec::with_capacity(64 + blocks.len() * 10 + nodes.len() * 24);

    // uncompressed_hash — 16 zero bytes. Unity uses this as an integrity
    // hint for cache reuse; not used for load-time validation. Production
    // bundles emit all zeros.
    out.extend_from_slice(&[0u8; 16]);

    // Block table.
    write_u32_be(&mut out, blocks.len() as u32)?;
    for blk in blocks {
        write_u32_be(&mut out, blk.uncompressed_size)?;
        write_u32_be(&mut out, blk.compressed_size)?;
        out.extend_from_slice(&blk.flags.to_be_bytes());
    }

    // Node table.
    write_u32_be(&mut out, nodes.len() as u32)?;
    for node in nodes {
        write_i64_be(&mut out, node.offset)?;
        write_i64_be(&mut out, node.size)?;
        write_u32_be(&mut out, node.flags)?;
        write_cstring(&mut out, &node.path)?;
    }

    Ok(out)
}

#[derive(Debug, Clone, Copy)]
struct BlockEntry {
    uncompressed_size: u32,
    compressed_size: u32,
    flags: u16,
}

#[derive(Debug, Clone)]
struct NodeEntry {
    offset: i64,
    size: i64,
    flags: u32,
    path: String,
}

// ---------------------------------------------------------------------------
// Data chunking + compression
// ---------------------------------------------------------------------------

/// Split a payload into ≤ DATA_BLOCK_CHUNK_SIZE uncompressed chunks,
/// LZ4-compress each, and return a Vec of (compressed_bytes, block_entry).
fn chunk_and_compress(payload: &[u8]) -> Result<(Vec<u8>, Vec<BlockEntry>), SerializeError> {
    let mut blocks: Vec<BlockEntry> = Vec::new();
    let mut compressed_data = Vec::with_capacity(payload.len());

    // Empty bundle is legal — Unity emits zero blocks in that case.
    // Production bundles never have an empty data section, but the
    // edge case keeps our tests trivial.
    if payload.is_empty() {
        return Ok((compressed_data, blocks));
    }

    for chunk in payload.chunks(DATA_BLOCK_CHUNK_SIZE) {
        // lz4_flex's `compress` produces a raw LZ4 block (matches what
        // Unity's reader expects when the block flag is LZ4). It does
        // NOT prefix a length; consumers know the uncompressed length
        // from the BlockInfo entry.
        let compressed = block::compress(chunk);
        blocks.push(BlockEntry {
            uncompressed_size: chunk.len() as u32,
            compressed_size: compressed.len() as u32,
            flags: BLOCK_FLAG_LZ4,
        });
        compressed_data.extend_from_slice(&compressed);
    }

    Ok((compressed_data, blocks))
}

// ---------------------------------------------------------------------------
// Top-level writer
// ---------------------------------------------------------------------------

pub fn write_bundle(opts: UnityFsWriteOptions<'_>) -> Result<Vec<u8>, SerializeError> {
    // 1. Concatenate node payloads in order. Track per-node offsets +
    // sizes for the directory.
    let mut data_payload: Vec<u8> = Vec::new();
    let mut node_entries: Vec<NodeEntry> = Vec::with_capacity(opts.nodes.len());
    for node in &opts.nodes {
        node_entries.push(NodeEntry {
            offset: data_payload.len() as i64,
            size: node.payload.len() as i64,
            flags: node.flags,
            path: node.path.clone(),
        });
        data_payload.extend_from_slice(&node.payload);
    }

    // 2. Chunk + LZ4-compress the data payload. Build the BlockInfo
    // block table from the compressed sizes.
    let (compressed_data, block_entries) = chunk_and_compress(&data_payload)?;

    // 3. Serialise the BlockInfoAndDirectory section uncompressed, then
    // LZ4-compress it (Unity's writer always compresses the block info
    // when COMPRESSION_LZ4HC is set in flags). We use plain LZ4 here
    // (same wire shape as LZ4HC for the reader; LZ4HC is a quality
    // tweak we'd add once we have a fixture to compare against).
    let bi_uncompressed = write_block_info_uncompressed(&block_entries, &node_entries)?;
    let bi_compressed = block::compress(&bi_uncompressed);

    // 4. Compute the total file size — needed for the header's
    // `total_file_size` field, which Unity reads as an i64 BE up
    // front. We size the header first via a dry-run.
    let header_prefix_size = {
        let mut sink = Vec::with_capacity(64);
        write_header_prefix(&mut sink, opts.unity_revision)?;
        sink.len()
    };
    // Remaining header fields after the prefix: i64 total_size, u32
    // bi_compressed_size, u32 bi_uncompressed_size, u32 flags.
    let header_total_size = header_prefix_size + 8 + 4 + 4 + 4;
    let total_file_size: i64 =
        (header_total_size + bi_compressed.len() + compressed_data.len()) as i64;

    // 5. Flag bits: BlockInfoAndDirectory is LZ4-compressed (FLAG_BLOCKINFO_COMPRESSED),
    // compression type for the data is LZ4 (low 6 bits = COMPRESSION_LZ4).
    // We deliberately do NOT set FLAG_BLOCKINFO_AT_END — Unity's reader
    // accepts both layouts; placing BlockInfo before the data is what
    // some Unity writers default to and simplifies our seek math.
    // Writer flags: LZ4 compression on both BlockInfo and data, with
    // the modern combined BlockInfo+Directory layout. We don't set
    // BLOCKS_INFO_AT_THE_END or BLOCK_INFO_NEED_PADDING_AT_START — both
    // are optional per the loader, and starting simple keeps the
    // writer's seek math straightforward. Real Unity 2022.3.x bundles
    // also set those bits; our reader handles both layouts.
    let flags: u32 = COMPRESSION_LZ4 | FLAG_BLOCKS_AND_DIRECTORY_INFO_COMBINED;
    debug_assert!(flags & COMPRESSION_TYPE_MASK == COMPRESSION_LZ4);

    // 6. Assemble.
    let mut out = Vec::with_capacity(header_total_size + bi_compressed.len() + compressed_data.len());
    write_header_prefix(&mut out, opts.unity_revision)?;
    write_i64_be(&mut out, total_file_size)?;
    write_u32_be(&mut out, bi_compressed.len() as u32)?;
    write_u32_be(&mut out, bi_uncompressed.len() as u32)?;
    write_u32_be(&mut out, flags)?;
    out.extend_from_slice(&bi_compressed);
    out.extend_from_slice(&compressed_data);

    Ok(out)
}

// ---------------------------------------------------------------------------
// Reader — promoted from test-only to public so the `extract-typetrees`
// binary can use it. The reader is round-trip tested against our own
// writer in this module's tests; correctness against a Unity-built
// bundle is verified when the binary is run against a real production
// bundle.
// ---------------------------------------------------------------------------

#[derive(Debug)]
pub struct ParsedBundle {
    pub unity_revision: String,
    pub legacy_unity_version: String,
    pub total_file_size: i64,
    pub flags: u32,
    pub block_info_uncompressed: Vec<u8>,
    pub data_payload_uncompressed: Vec<u8>,
    /// Directory entries — one per node Unity packed into the bundle.
    /// Production bundles often have 2: the CAB-prefixed SerializedFile
    /// and a sibling `.resS` resource file carrying texture/mesh
    /// bytes that the SerializedFile references by offset. Callers
    /// extracting a specific node slice the `data_payload_uncompressed`
    /// using `(offset, size)`.
    pub directory: Vec<ParsedDirectoryNode>,
}

#[derive(Debug, Clone)]
pub struct ParsedDirectoryNode {
    pub offset: i64,
    pub size: i64,
    pub flags: u32,
    pub path: String,
}

/// Parse a UnityFS bundle into its constituent sections. Decompresses
/// both the BlockInfo+Directory section and the data blocks.
pub fn parse_bundle(bytes: &[u8]) -> Result<ParsedBundle, SerializeError> {
    let mut cur = 0usize;

    if bytes.len() < SIGNATURE.len() + 4 {
        return Err(SerializeError::Format("bundle too short".into()));
    }
    if &bytes[..SIGNATURE.len()] != SIGNATURE {
        return Err(SerializeError::Format("bad signature".into()));
    }
    cur += SIGNATURE.len();

    // Accept a range of format versions. Unity 2021.x and 2022.x both
    // emit version 8 in observed bundles; 6 and 7 may exist in older
    // ab-cdn caches.
    let format = u32::from_be_bytes(bytes[cur..cur + 4].try_into().unwrap());
    cur += 4;
    if !(MIN_READER_FORMAT_VERSION..=MAX_READER_FORMAT_VERSION).contains(&format) {
        return Err(SerializeError::Format(format!(
            "format version {format} outside accepted range [{MIN_READER_FORMAT_VERSION}, {MAX_READER_FORMAT_VERSION}]"
        )));
    }

    // Field order: legacy "5.x.x\0" comes BEFORE the actual
    // unity_revision. Verified against a 2022.3.12f1 production bundle.
    let (legacy_unity_version, n1) = read_cstring(&bytes[cur..])?;
    cur += n1;
    let (unity_revision, n2) = read_cstring(&bytes[cur..])?;
    cur += n2;

    let total_file_size = i64::from_be_bytes(bytes[cur..cur + 8].try_into().unwrap());
    cur += 8;
    let bi_compressed_size = u32::from_be_bytes(bytes[cur..cur + 4].try_into().unwrap()) as usize;
    cur += 4;
    let bi_uncompressed_size = u32::from_be_bytes(bytes[cur..cur + 4].try_into().unwrap()) as usize;
    cur += 4;
    let flags = u32::from_be_bytes(bytes[cur..cur + 4].try_into().unwrap());
    cur += 4;
    let header_end = cur;

    // Compression type: low 6 bits of `flags`. Both LZ4 (2) and LZ4HC
    // (3) use the same wire format; lz4_flex's `decompress` handles
    // both. LZMA (1) is rejected — we don't pull in the LZMA crate.
    let compression_type = flags & COMPRESSION_TYPE_MASK;
    if compression_type != COMPRESSION_NONE
        && compression_type != COMPRESSION_LZ4
        && compression_type != COMPRESSION_LZ4HC
    {
        return Err(SerializeError::Format(format!(
            "unsupported compression type {compression_type} in flags 0x{flags:x}"
        )));
    }

    // BlockInfo location: BLOCKS_INFO_AT_THE_END (bit 0x80) controls
    // whether it sits at the end of the file. When clear (the case in
    // our verified bundle, flags=0x243), it follows the header — but
    // may be 16-byte-aligned via BLOCK_INFO_NEED_PADDING_AT_START
    // (bit 0x200).
    let bi_start: usize = if flags & FLAG_BLOCKS_INFO_AT_THE_END != 0 {
        bytes
            .len()
            .checked_sub(bi_compressed_size)
            .ok_or_else(|| SerializeError::Format("bi_compressed_size larger than file".into()))?
    } else if flags & FLAG_BLOCK_INFO_NEED_PADDING_AT_START != 0 {
        // Pad header_end up to a 16-byte boundary.
        (header_end + 15) & !15
    } else {
        header_end
    };
    let bi_end = bi_start
        .checked_add(bi_compressed_size)
        .ok_or_else(|| SerializeError::Format("bi range overflow".into()))?;
    if bi_end > bytes.len() {
        return Err(SerializeError::Format(format!(
            "BlockInfo section ({bi_start}..{bi_end}) exceeds file size {}",
            bytes.len()
        )));
    }
    let bi_compressed = &bytes[bi_start..bi_end];

    // BlockInfo compression matches the data compression — the low 6
    // bits of `flags`. No separate "BlockInfo compressed" bit in format
    // 8. If compression_type is NONE, BlockInfo is raw bytes.
    let block_info_uncompressed = if compression_type == COMPRESSION_NONE {
        bi_compressed.to_vec()
    } else {
        block::decompress(bi_compressed, bi_uncompressed_size)
            .map_err(|e| SerializeError::Format(format!("BlockInfo LZ4 decompress: {e}")))?
    };

    // Read the block table back to drive data decompression.
    let mut bi_cur = 16usize; // skip uncompressed_hash
    let block_count =
        u32::from_be_bytes(block_info_uncompressed[bi_cur..bi_cur + 4].try_into().unwrap())
            as usize;
    bi_cur += 4;
    let mut data_payload_uncompressed = Vec::new();
    // Data position depends on layout:
    //   * BLOCKS_INFO_AT_THE_END set → data is between header_end (or
    //     padded header_end) and bi_start.
    //   * BLOCKS_INFO_AT_THE_END clear → data is right after the
    //     BlockInfo section.
    //
    // When BLOCK_INFO_NEED_PADDING_AT_START is set, BOTH the BlockInfo
    // section AND the data section start at 16-byte-aligned offsets.
    // Verified on the 2022.3.12f1 bundle: bi_end=148, data actually
    // starts at 160 (next 16-byte boundary after bi_end), with 12 zero
    // bytes of padding in between.
    let raw_data_start = if flags & FLAG_BLOCKS_INFO_AT_THE_END != 0 {
        header_end
    } else {
        bi_end
    };
    let mut data_cur = if flags & FLAG_BLOCK_INFO_NEED_PADDING_AT_START != 0 {
        (raw_data_start + 15) & !15
    } else {
        raw_data_start
    };
    for _ in 0..block_count {
        let unc_size = u32::from_be_bytes(
            block_info_uncompressed[bi_cur..bi_cur + 4].try_into().unwrap(),
        ) as usize;
        bi_cur += 4;
        let c_size = u32::from_be_bytes(
            block_info_uncompressed[bi_cur..bi_cur + 4].try_into().unwrap(),
        ) as usize;
        bi_cur += 4;
        let block_flags =
            u16::from_be_bytes(block_info_uncompressed[bi_cur..bi_cur + 2].try_into().unwrap());
        bi_cur += 2;
        let compressed_chunk = &bytes[data_cur..data_cur + c_size];
        data_cur += c_size;
        // Per-block compression type lives in the block flags' low bits,
        // same dispatch as the overall bundle flags.
        let block_compression = (block_flags as u32) & COMPRESSION_TYPE_MASK;
        let chunk = if block_compression == COMPRESSION_NONE {
            compressed_chunk.to_vec()
        } else {
            block::decompress(compressed_chunk, unc_size)
                .map_err(|e| SerializeError::Format(format!("data LZ4 decompress: {e}")))?
        };
        data_payload_uncompressed.extend_from_slice(&chunk);
    }

    // After block_count entries, the BlockInfo carries the directory:
    // u32 BE node_count + per-node { i64 BE offset, i64 BE size, u32 BE
    // flags, cstring path }. We've already read 16 (hash) + 4
    // (block_count) + (block_count * 10) (block entries) bytes.
    let dir_cursor_start = 16 + 4 + (block_count * 10);
    let mut dir_cur = dir_cursor_start;
    let node_count = u32::from_be_bytes(
        block_info_uncompressed[dir_cur..dir_cur + 4]
            .try_into()
            .unwrap(),
    ) as usize;
    dir_cur += 4;
    let mut directory = Vec::with_capacity(node_count);
    for _ in 0..node_count {
        let offset = i64::from_be_bytes(
            block_info_uncompressed[dir_cur..dir_cur + 8]
                .try_into()
                .unwrap(),
        );
        dir_cur += 8;
        let size = i64::from_be_bytes(
            block_info_uncompressed[dir_cur..dir_cur + 8]
                .try_into()
                .unwrap(),
        );
        dir_cur += 8;
        let n_flags = u32::from_be_bytes(
            block_info_uncompressed[dir_cur..dir_cur + 4]
                .try_into()
                .unwrap(),
        );
        dir_cur += 4;
        let (path, advance) = read_cstring(&block_info_uncompressed[dir_cur..])?;
        dir_cur += advance;
        directory.push(ParsedDirectoryNode {
            offset,
            size,
            flags: n_flags,
            path,
        });
    }

    Ok(ParsedBundle {
        unity_revision,
        legacy_unity_version,
        total_file_size,
        flags,
        block_info_uncompressed,
        data_payload_uncompressed,
        directory,
    })
}

fn read_cstring(bytes: &[u8]) -> Result<(String, usize), SerializeError> {
    let null_idx = bytes
        .iter()
        .position(|&b| b == 0)
        .ok_or_else(|| SerializeError::Format("unterminated cstring".into()))?;
    let s = std::str::from_utf8(&bytes[..null_idx])
        .map_err(|e| SerializeError::Format(format!("invalid utf8 in cstring: {e}")))?
        .to_string();
    Ok((s, null_idx + 1))
}

// ---------------------------------------------------------------------------
// Tests — verify the self-consistent parts. Reader-against-our-writer
// only; does not verify Unity's own loader would accept the output.
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lz4_roundtrip_baseline() {
        // Sanity: lz4_flex's API works the way we expect for arbitrary
        // bytes. If this fails, every other test in this file would
        // fail too — locate the regression in the crate, not in our
        // writer.
        let payload: Vec<u8> = (0..10_000).map(|i| (i % 251) as u8).collect();
        let c = block::compress(&payload);
        let d = block::decompress(&c, payload.len()).unwrap();
        assert_eq!(d, payload);
    }

    #[test]
    fn empty_bundle_roundtrip() {
        let bytes = write_bundle(UnityFsWriteOptions {
            unity_revision: "2021.3.20f1",
            nodes: vec![],
        })
        .unwrap();
        let parsed = parse_bundle(&bytes).unwrap();
        assert_eq!(parsed.unity_revision, "2021.3.20f1");
        assert_eq!(parsed.legacy_unity_version, LEGACY_UNITY_VERSION);
        assert_eq!(parsed.total_file_size as usize, bytes.len());
        assert_eq!(parsed.flags & COMPRESSION_TYPE_MASK, COMPRESSION_LZ4);
        assert!(parsed.data_payload_uncompressed.is_empty());
    }

    #[test]
    fn single_node_roundtrip() {
        // ~300 KiB payload — guaranteed to chunk into multiple data
        // blocks (DATA_BLOCK_CHUNK_SIZE = 128 KiB), exercising the
        // multi-block path.
        let payload: Vec<u8> = (0u32..300_000).map(|i| (i.wrapping_mul(31) % 251) as u8).collect();
        let node = DirectoryNode::serialized_file(payload.clone());
        let bytes = write_bundle(UnityFsWriteOptions {
            unity_revision: "2021.3.20f1",
            nodes: vec![node],
        })
        .unwrap();
        let parsed = parse_bundle(&bytes).unwrap();
        assert_eq!(parsed.data_payload_uncompressed, payload);
    }

    #[test]
    fn cab_path_is_deterministic() {
        // Stability: the same payload produces the same CAB-name across
        // runs. Drives byte-stable bundle output for the same input.
        let payload = b"deterministic input".to_vec();
        let a = DirectoryNode::serialized_file(payload.clone());
        let b = DirectoryNode::serialized_file(payload);
        assert_eq!(a.path, b.path);
    }

    #[test]
    fn header_signature_is_unity_fs_null() {
        let bytes = write_bundle(UnityFsWriteOptions {
            unity_revision: "2021.3.20f1",
            nodes: vec![],
        })
        .unwrap();
        assert_eq!(&bytes[..8], b"UnityFS\0");
    }
}
