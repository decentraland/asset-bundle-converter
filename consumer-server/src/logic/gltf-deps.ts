import * as path from 'path'

// glTF 2.0 binary container format:
//   header  = 12 bytes: [magic u32=0x46546C67 "glTF" LE, version u32=2, length u32]
//   chunk 0 = 8 bytes header [chunkLength u32, chunkType u32=0x4E4F534A "JSON"] + JSON payload
//   chunk 1 = 8 bytes header [chunkLength u32, chunkType u32=0x004E4942 "BIN"] + optional binary blob
// We only need chunk 0 (the embedded glTF JSON) to enumerate external dep URIs.
// Spec reference: https://registry.khronos.org/glTF/specs/2.0/glTF-2.0.html#binary-gltf-layout
const GLB_MAGIC = 0x46546c67
const GLB_CHUNK_TYPE_JSON = 0x4e4f534a
const GLB_HEADER_BYTES = 12
const GLB_CHUNK_HEADER_BYTES = 8

type GltfJson = {
  images?: Array<{ uri?: unknown } | null | undefined>
  buffers?: Array<{ uri?: unknown } | null | undefined>
}

/**
 * Extract the embedded glTF JSON text from a .glb/.gltf byte buffer.
 *
 * `.gltf` is plain UTF-8 JSON — the bytes are returned verbatim as a string.
 * `.glb` carries a binary wrapper; we validate the magic + version and slice
 * the first JSON chunk. Any deviation from glTF 2.0 binary layout throws — a
 * malformed glTF would fail Unity conversion anyway, so failing fast server-
 * side turns a late Unity-spawn failure into an immediate, catalogable error.
 */
function extractGltfJson(bytes: Buffer, ext: '.glb' | '.gltf'): string {
  if (ext === '.gltf') return bytes.toString('utf8')

  if (bytes.length < GLB_HEADER_BYTES + GLB_CHUNK_HEADER_BYTES) {
    throw new Error(`glb too short: ${bytes.length} bytes`)
  }
  const magic = bytes.readUInt32LE(0)
  if (magic !== GLB_MAGIC) {
    throw new Error(`glb magic mismatch: expected 0x${GLB_MAGIC.toString(16)}, got 0x${magic.toString(16)}`)
  }
  const version = bytes.readUInt32LE(4)
  if (version !== 2) {
    throw new Error(`unsupported glb version: ${version} (only glTF 2.0 is supported)`)
  }

  const chunkLength = bytes.readUInt32LE(GLB_HEADER_BYTES)
  const chunkType = bytes.readUInt32LE(GLB_HEADER_BYTES + 4)
  if (chunkType !== GLB_CHUNK_TYPE_JSON) {
    throw new Error(`glb first chunk is not JSON (type 0x${chunkType.toString(16)})`)
  }
  const jsonStart = GLB_HEADER_BYTES + GLB_CHUNK_HEADER_BYTES
  const jsonEnd = jsonStart + chunkLength
  if (jsonEnd > bytes.length) {
    throw new Error(`glb JSON chunk (${chunkLength} bytes) overruns buffer (${bytes.length} bytes)`)
  }
  // glTF 2.0 says JSON chunks must be padded to 4-byte alignment with space
  // (0x20), which `JSON.parse` tolerates as trailing whitespace. But exporters
  // in the wild (Blender's older glb path, some DCC plugins) sometimes use
  // null bytes instead — `JSON.parse` rejects those with "Unexpected non-
  // whitespace character". Strip trailing nulls AND whitespace so we match the
  // same tolerance Unity / GLTFast offer for non-conformant inputs.
  let end = jsonEnd
  while (end > jsonStart) {
    const b = bytes[end - 1]
    if (b === 0x00 || b === 0x20 || b === 0x09 || b === 0x0a || b === 0x0d) end--
    else break
  }
  return bytes.toString('utf8', jsonStart, end)
}

/**
 * Parse a glb/gltf buffer and return the deduplicated set of external URI
 * references (glTF `images[].uri` and `buffers[].uri`). Data-URIs and
 * embedded buffers (missing `uri`) are filtered out — they're not external
 * dependencies.
 *
 * Order-invariance is a load-bearing correctness property: two glbs with
 * identical dep sets listed in different JSON order MUST produce identical
 * outputs here so per-asset digests collide. We return a plain array sorted
 * ASCIIbetically; downstream code sorts again before hashing, but sorting
 * here makes the contract explicit at the parser boundary.
 *
 * Dedup protects against a common failure mode: two creators exporting the
 * same mesh with different material structure can end up with the same
 * texture referenced from one `images[]` slot vs two. Same dep set either
 * way — same digest either way.
 */
export function parseGltfDepRefs(bytes: Buffer, ext: '.glb' | '.gltf'): string[] {
  const jsonText = extractGltfJson(bytes, ext)

  let parsed: unknown
  try {
    parsed = JSON.parse(jsonText)
  } catch (err: any) {
    throw new Error(`glTF JSON parse failed: ${err.message}`)
  }
  // `JSON.parse("null")` returns null (no throw), and `JSON.parse("42")` returns a
  // number. Neither is a valid glTF root — guard explicitly so the subsequent
  // `.images`/`.buffers` access can't crash with an ugly "Cannot read properties
  // of null" that our top-level handler would pass straight through.
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(
      `glTF root must be an object, got ${parsed === null ? 'null' : Array.isArray(parsed) ? 'array' : typeof parsed}`
    )
  }
  const doc = parsed as GltfJson

  const uris = new Set<string>()
  const collectFrom = (arr: GltfJson['images'] | GltfJson['buffers']) => {
    if (!Array.isArray(arr)) return
    for (const entry of arr) {
      if (!entry || typeof entry !== 'object') continue
      const uri = (entry as any).uri
      if (typeof uri !== 'string') continue // embedded / bufferView-backed
      if (uri.startsWith('data:')) continue // inline base64, not an external dep
      uris.add(uri)
    }
  }
  collectFrom(doc.images)
  collectFrom(doc.buffers)

  return Array.from(uris).sort()
}

/**
 * Resolve a glTF URI (relative path) against the glb's own location in the
 * entity and return the key used to look the dep up in `entity.content`.
 *
 * Percent-decodes (glTF allows encoded URIs) and normalizes with
 * `path.posix.normalize` so `foo/../bar.png` and `./bar.png` and `bar.png`
 * collapse to a single lookup key. Paths that escape the entity root (leading
 * `..` after normalization) are rejected — no DCL scene has legitimate reason
 * to reference outside its own `content` map, and accepting them would allow
 * a malformed/malicious glTF to drag an unrelated file into the digest.
 *
 * Also rejects non-relative URI forms up front with clear errors. glTF 2.0
 * technically allows absolute URLs, protocol-relative URLs, query strings,
 * and fragments, but:
 *   - Unity's conversion pipeline never fetches remote resources — it loads
 *     from the local filesystem after the catalyst download — so an absolute
 *     URL would never produce a valid bundle anyway.
 *   - `entity.content` is keyed on plain filenames; a `?v=2` suffix would
 *     mis-route to "not in entity content" and mask the real problem.
 *   - Letting these fall through to the lookup produces misleading "not in
 *     the entity content" errors instead of pointing at the actual issue.
 * Scheme / protocol-relative / leading-slash / query / fragment are all
 * checked BEFORE percent-decoding — schemes are always ASCII and percent-
 * encoded variants of `?`/`#` are rare in practice, so we let those pass
 * through to `contentByFile.get` rather than adding a second check pass.
 */
export function resolveUriToContentFile(uri: string, glbFile: string): string {
  if (uri === '') {
    throw new Error('glTF URI is empty')
  }
  if (/^[a-zA-Z][a-zA-Z0-9+.\-]*:/.test(uri)) {
    throw new Error(`glTF URI "${uri}" has a URI scheme — only relative paths are supported`)
  }
  if (uri.startsWith('//')) {
    throw new Error(`glTF URI "${uri}" is protocol-relative — only relative paths are supported`)
  }
  if (uri.startsWith('/')) {
    throw new Error(`glTF URI "${uri}" is an absolute path — only relative paths are supported`)
  }
  if (uri.includes('?') || uri.includes('#')) {
    throw new Error(`glTF URI "${uri}" contains a query/fragment component, which is not supported`)
  }

  let decoded: string
  try {
    decoded = decodeURIComponent(uri)
  } catch (err: any) {
    throw new Error(`invalid percent-encoding in glTF URI "${uri}": ${err.message}`)
  }

  const base = path.posix.dirname(glbFile)
  const joined = base === '.' || base === '' ? decoded : path.posix.join(base, decoded)
  const normalized = path.posix.normalize(joined)

  if (normalized.startsWith('../') || normalized === '..') {
    throw new Error(`glTF URI "${uri}" escapes entity root (resolved to "${normalized}")`)
  }
  return normalized
}
