// Shared glb builder for tests. Previously duplicated in three spec files
// (gltf-deps.spec.ts, asset-reuse.spec.ts, execute-conversion.spec.ts).
// Kept minimal on purpose — if the glb spec semantics we care about ever
// change (chunk ordering, alignment, etc.), one edit here propagates.

/**
 * Build a minimal glTF 2.0 binary referencing the given URIs via images[]
 * and buffers[]. Produces a valid header + a single JSON chunk; no BIN
 * chunk (the parser doesn't need one for dep extraction).
 *
 * Useful for tests that exercise `parseGltfDepRefs` /
 * `computePerAssetDigests` / the end-to-end conversion pipeline without
 * needing real glb assets on disk.
 */
export function buildGlb(images: string[] = [], buffers: string[] = []): Buffer {
  const json = JSON.stringify({
    images: images.map((uri) => ({ uri })),
    buffers: buffers.map((uri) => ({ uri }))
  })
  const jsonBytes = Buffer.from(json, 'utf8')
  const total = 12 + 8 + jsonBytes.length
  const buf = Buffer.alloc(total)
  buf.writeUInt32LE(0x46546c67, 0) // magic "glTF"
  buf.writeUInt32LE(2, 4) // version
  buf.writeUInt32LE(total, 8) // total length
  buf.writeUInt32LE(jsonBytes.length, 12) // chunk 0 length
  buf.writeUInt32LE(0x4e4f534a, 16) // chunk 0 type "JSON"
  jsonBytes.copy(buf, 20)
  return buf
}
