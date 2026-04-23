import { Entity } from '@dcl/schemas'
import { ILoggerComponent } from '@well-known-components/interfaces'
import * as path from 'path'
import * as fs from 'fs/promises'
import * as crypto from 'crypto'
import { AppComponents } from '../types'
import { normalizeContentsBaseUrl } from '../utils'
import { bufferExtensions, fileExtension, gltfExtensions, textureExtensions } from './extensions'
import { parseGltfDepRefs, resolveUriToContentFile } from './gltf-deps'
import { isS3NotFound } from './s3-helpers'

// Re-export so callers still referencing `asset-reuse.ts` for this helper keep
// working. Single source of truth is `extensions.ts`.
export { fileExtension } from './extensions'

// Extensions whose bundles the converter actually uploads and we can therefore
// probe at the canonical prefix. `.bin` is deliberately absent: Unity never
// marks `.bin` files as their own asset bundles (`AssetBundleConverter.cs`
// `MarkAllAssetBundles` early-continues on `.bin`), so no `{hash}_{target}`
// object at the canonical prefix ever represents a buffer. Probing `.bin`
// hashes would just add S3 HEAD calls that always miss, and worse it would
// permanently block the full-cache short-circuit for every scene with a
// buffer file (which is most of them).
const PROBE_EXTENSIONS = new Set<string>([...gltfExtensions, ...textureExtensions])

// Unity-side extensions whose asset bundles have no inbound dependencies from
// other assets, so the converter can safely skip downloading & re-building
// them via the `-cachedHashes` flag when the canonical bundle already exists.
// Textures are intentionally excluded — they can still be referenced from
// within a non-cached GLTF during import, so we keep downloading them
// regardless of cache status. `.bin` is not here either: it never has a
// canonical bundle to hit in the first place (see PROBE_EXTENSIONS above).
const UNITY_SKIPPABLE_EXTENSIONS = new Set<string>([...gltfExtensions])

// Extensions that a `.glb` / `.gltf` bundle can reference as dependencies. The
// bundle output bytes embed the referenced dep bundle names (themselves derived
// from dep content hashes), so two scenes that share a glb source hash but
// differ in their dep set produce byte-different bundles — distinct canonical
// paths prevent cross-scene collision. Buffers ARE included here even though
// they're not probed directly: a `.gltf` (text) bundle's output DOES embed
// references to the buffer bundle Unity produces as part of the GLTF's own
// bundle, so the buffer hashes participate in the digest.
const GLB_DEP_EXTENSIONS = new Set<string>([...bufferExtensions, ...textureExtensions])

const GLTF_EXTENSIONS_SET = new Set<string>(gltfExtensions)

export type AssetCacheResult = {
  cachedHashes: string[]
  missingHashes: string[]
  // Hashes Unity can safely skip building. Subset of cachedHashes limited to file
  // extensions whose bundles have no inbound Unity dependencies from other assets.
  unitySkippableHashes: string[]
  // Composite-or-bare canonical bundle filename per content hash, so callers
  // (short-circuit manifest emit, post-Unity manifest append) don't have to
  // reconstruct the composite form.
  canonicalNameByHash: Record<string, string>
  // Per-glb/gltf deps digest — keyed by asset hash. Passed to Unity so it names
  // each glb/gltf bundle with the same composite key we probed and will upload to.
  // Non-glb entries (textures, buffers) don't appear in this map; their canonical
  // filename is hash-only.
  depsDigestByHash: ReadonlyMap<string, string>
}

/**
 * Deterministic digest of the entity's texture + buffer set. Folded into
 * glb/gltf canonical filenames so two scenes that share a glb source hash but
 * differ in deps land at distinct paths.
 *
 * Conservative superset — digests every texture/buffer in the entity, not just
 * the subset a specific glb actually references. Zero false-positive risk
 * (identical digest ⇒ identical dep set ⇒ identical Unity output). May miss
 * some cross-scene reuse when an entity carries loose non-glb textures; we
 * accept that trade-off.
 *
 * Sort is filename-primary, hash-secondary so it's stable regardless of
 * catalyst response order and robust to two different filenames sharing a hash.
 *
 * Exported for unit testing.
 */
export function computeDepsDigest(entityContent: ReadonlyArray<{ file: string; hash: string }>): string {
  const deps = entityContent.filter((e) => GLB_DEP_EXTENSIONS.has(fileExtension(e.file)))
  deps.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : a.hash < b.hash ? -1 : a.hash > b.hash ? 1 : 0))
  // Feed JSON.stringify of the sorted tuple array rather than a hand-rolled
  // `${file}\t${hash}\n` concatenation so a filename that happens to contain a
  // tab or newline can't line-shift its neighbour's bytes into an identical
  // digest for a different dep set. DCL filenames are well-formed in practice,
  // but correctness shouldn't rely on that.
  const payload = JSON.stringify(deps.map((d) => [d.file, d.hash]))
  // 32 hex = 128-bit. Birthday-paradox collision probability at k tuples is
  // ~k² / 2·2¹²⁸ ≈ k² / 6.8·10³⁸. Even at 10¹⁸ tuples (astronomically
  // beyond any realistic DCL scale) the probability is ~10⁻³; at 10⁹ it's
  // ~10⁻²¹. The earlier version truncated to 16 hex (64-bit) which was
  // also safely above DCL's scale, but for critical-infrastructure
  // headroom this is essentially free — 16 extra chars in the filename at
  // rest, invisible to clients (who read the manifest opaquely) and
  // negligible in every downstream consumer.
  return crypto.createHash('sha256').update(payload).digest('hex').slice(0, 32)
}

/**
 * Build the canonical bundle filename Unity's output drops into
 * `{abVersion}/assets/{filename}`. glb/gltf filenames embed a `depsDigest`;
 * BINs and textures are keyed by hash alone (they're leaves with no inbound
 * dep refs from their own bundle).
 *
 * The digest input is an opaque string — callers decide whether it's an
 * entity-wide aggregate (legacy: `migrate-to-canonical.ts`) or a per-asset
 * digest (current: `checkAssetCache` via `canonicalFilenameForAsset`). This
 * function doesn't care, it just concatenates.
 *
 * Exported for unit testing and so the migration script produces keys that
 * match this function's rules exactly.
 */
export function canonicalFilename(hash: string, ext: string, target: string, depsDigest: string): string {
  if (GLTF_EXTENSIONS_SET.has(ext)) {
    return `${hash}_${depsDigest}_${target}`
  }
  return `${hash}_${target}`
}

/**
 * Per-asset-digest variant of `canonicalFilename`. Looks up the digest for this
 * specific asset hash in the map produced by `computePerAssetDigests`.
 *
 * Throws for glb/gltf hashes missing from the map — that would mean the caller
 * is probing an asset whose deps we haven't digested, and silently falling back
 * to a bare `{hash}_{target}` name would mis-align the probe key with the
 * filename Unity will emit. Missing digest for non-glb extensions is fine
 * (they're leaves; the map isn't expected to contain them).
 */
export function canonicalFilenameForAsset(
  hash: string,
  ext: string,
  target: string,
  depsDigestByHash: ReadonlyMap<string, string>
): string {
  if (GLTF_EXTENSIONS_SET.has(ext)) {
    const digest = depsDigestByHash.get(hash)
    if (!digest) throw new Error(`missing per-asset deps digest for glb/gltf hash ${hash}`)
    return `${hash}_${digest}_${target}`
  }
  return `${hash}_${target}`
}

// Process-local LRU cache of canonical keys confirmed to exist in S3. Canonical
// bundles are immutable once written (immutable Cache-Control, content-addressed
// path), so a HIT is valid forever — we evict purely on usage pressure, not on
// time. MISSES are intentionally NOT cached: another worker racing the same asset
// may have just uploaded it, and a stale-miss would force pointless Unity
// re-conversion.
//
// The entries are plain canonical keys (`{abVersion}/assets/{hash}_{target}`) so
// that a version bump or a different build target never returns a false positive.
// LRU ordering is maintained via JS Set insertion order — on every hit we
// delete + re-add the key so it becomes the most-recently-used entry, and on
// eviction we drop the first (least-recently-used) element.
//
// The members below are named function expressions that reference the
// `probeHitCache` module binding directly (not `this`), so destructured
// usage like `const { has, add } = probeHitCache; add(k); has(k)` still works
// — see the unit-test covering that pattern.
// Exported for unit testing.
export const probeHitCache = {
  hits: new Set<string>(),
  maxSize: 20_000,
  has: function (key: string): boolean {
    if (!probeHitCache.hits.has(key)) return false
    // Touch: move the key to the back of the Set so it's now the MRU entry.
    probeHitCache.hits.delete(key)
    probeHitCache.hits.add(key)
    return true
  },
  add: function (key: string) {
    // If the key is already present, just refresh its LRU position.
    if (probeHitCache.hits.has(key)) {
      probeHitCache.hits.delete(key)
      probeHitCache.hits.add(key)
      return
    }
    // New key + at capacity: evict the least-recently-used entry (front of Set).
    if (probeHitCache.hits.size >= probeHitCache.maxSize) {
      const lru = probeHitCache.hits.values().next().value
      if (lru !== undefined) probeHitCache.hits.delete(lru)
    }
    probeHitCache.hits.add(key)
  },
  clear: function () {
    probeHitCache.hits.clear()
  }
}

/**
 * Extract the leading `{hash}` portion of a Unity-emitted bundle filename.
 *
 * Bundle filenames Unity emits look like `{hash}_{target}` optionally followed
 * by `.br` / `.manifest` / `.manifest.br`. Extracting the hash prefix lets
 * callers do an O(1) `Set.has` lookup against `cachedHashes` regardless of
 * which variant the file is.
 *
 * Returns `null` when the name doesn't follow the hash-prefixed convention —
 * for instance, generic Unity artifacts like `AssetBundles` / `AssetBundles.manifest`
 * that aren't content-addressed. Callers treat `null` as "not a cacheable
 * bundle" and leave the file alone.
 *
 * @param name - A filename from `readdir(outDirectory)` (no path, no slashes).
 * @returns The leading hash, or `null` for generic / unrecognized names.
 */
function extractHashFromBundleName(name: string): string | null {
  const underscore = name.indexOf('_')
  const dot = name.indexOf('.')
  // pick the earlier delimiter that is actually present
  const firstDelim = underscore < 0 ? dot : dot < 0 ? underscore : Math.min(underscore, dot)
  if (firstDelim <= 0) return null
  return name.substring(0, firstDelim)
}

/**
 * S3 HEAD probe that normalizes "not found" into `false` and surfaces every
 * other error. Uses `isS3NotFound` so the predicate is in one place.
 *
 * @param s3 - Configured AWS S3 client.
 * @param bucket - Bucket to probe.
 * @param key - Key to HEAD.
 * @returns `true` if the object exists, `false` on 404.
 * @throws Any non-404 error reaching the SDK (500, auth failure, etc.).
 */
async function headExists(s3: AppComponents['cdnS3'], bucket: string, key: string): Promise<boolean> {
  try {
    await s3.headObject({ Bucket: bucket, Key: key }).promise()
    return true
  } catch (err: unknown) {
    if (isS3NotFound(err)) return false
    throw err
  }
}

/**
 * Array-map with bounded concurrency — runs `fn` over every element of `items`
 * in parallel with at most `concurrency` in-flight promises at a time. Results
 * come back in the same order as `items`.
 *
 * Used to bound S3 HEAD probes in the per-asset cache, S3 `CopyObject` calls in
 * the migration script, and parallel `fs.unlink` calls in the purge step —
 * enough to saturate throughput without exhausting the default HTTPS agent pool
 * or hitting the container's `ulimit -n` on low-limit hosts.
 *
 * If `fn` rejects for any item, the whole promise rejects on first failure
 * (Promise.all semantics). Workers already in flight for other items keep
 * running until natural completion — their results are discarded. Clamps
 * `concurrency` to at least 1 so a caller accidentally passing 0 doesn't
 * return an array of holes.
 *
 * @param items - Inputs to process.
 * @param concurrency - Maximum number of simultaneous `fn` invocations.
 * @param fn - Per-item worker. Called with each element of `items`.
 * @returns Array of results in input order.
 */
export async function mapBounded<T, R>(items: T[], concurrency: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  if (items.length === 0) return []
  const results: R[] = new Array(items.length)
  let cursor = 0

  async function worker() {
    while (true) {
      const idx = cursor++
      if (idx >= items.length) return
      results[idx] = await fn(items[idx])
    }
  }

  // Clamp to at least 1 so a caller accidentally passing 0 doesn't leave the
  // returned array full of holes.
  const workerCount = Math.min(Math.max(1, concurrency), items.length)
  await Promise.all(Array.from({ length: workerCount }, () => worker()))
  return results
}

/**
 * Fetcher function used by `computePerAssetDigests` to pull glb/gltf bytes
 * from the catalyst. Kept as a plain parameter (rather than a component
 * dependency) so tests can swap in a memory-backed fetcher without mocking
 * `node-fetch`.
 */
export type GltfFetcher = (url: string) => Promise<Buffer>

// 256 MB upper bound on a single glb/gltf download. Defence-in-depth against
// a malicious or corrupted catalyst entry that declares an unbounded body —
// without this, `arrayBuffer()` would buffer the whole response before we see
// it. DCL's largest legitimate glbs are ~tens of MB, so 256 is generous
// headroom without risking an OOM on the conversion worker.
const MAX_GLTF_DOWNLOAD_BYTES = 256 * 1024 * 1024

/**
 * Default fetcher — wraps `node-fetch` with a non-ok status check and a
 * Content-Length guard. Kept out of the module-level imports so
 * `asset-reuse.ts` stays importable from pure-unit test paths that don't
 * want to pull in `node-fetch`'s transitive deps.
 *
 * Uses `arrayBuffer()` rather than `res.buffer()` — the latter is deprecated
 * in node-fetch v3 and removed in undici-based fetches. `Buffer.from(...)`
 * on the arrayBuffer is a zero-copy view (no extra allocation).
 */
async function defaultGltfFetcher(url: string): Promise<Buffer> {
  const { default: fetch } = await import('node-fetch')
  const res = await fetch(url)
  if (!res.ok) {
    throw new Error(`failed to fetch ${url}: ${res.status} ${res.statusText}`)
  }
  const declaredLength = Number(res.headers.get('content-length') ?? '-1')
  if (Number.isFinite(declaredLength) && declaredLength > MAX_GLTF_DOWNLOAD_BYTES) {
    throw new Error(
      `glb/gltf at ${url} declared Content-Length ${declaredLength} > ${MAX_GLTF_DOWNLOAD_BYTES} (refusing to buffer)`
    )
  }
  return Buffer.from(await res.arrayBuffer())
}

/**
 * Compute a per-glb/gltf deps digest for every gltf-extension asset in the
 * entity. For each glb/gltf: download the bytes, parse the embedded JSON to
 * enumerate its external URI refs, resolve each URI against `entity.content`
 * to get the `{file, hash}` tuples the glb actually depends on, and hash
 * that subset through `computeDepsDigest`.
 *
 * Two glbs with identical referenced dep sets (same file names, same content
 * hashes) produce identical digests regardless of ordering inside the glTF
 * JSON — guaranteed by `parseGltfDepRefs` dedup+sort on the way in and by
 * `computeDepsDigest`'s own sort. Two glbs whose dep sets differ in any entry
 * produce distinct digests.
 *
 * Malformed glTF / missing URI target / invalid percent-encoding: the promise
 * rejects. Callers (scene conversion) convert this into a scene failure, which
 * matches what Unity would do if it tried to convert the same bad content.
 */
export async function computePerAssetDigests(
  entity: Pick<Entity, 'content'>,
  contentServerUrl: string,
  options?: { fetcher?: GltfFetcher; concurrency?: number }
): Promise<Map<string, string>> {
  const fetcher = options?.fetcher ?? defaultGltfFetcher
  // 20 in-flight catalyst fetches — below the S3 HEAD probe concurrency (50)
  // because catalyst fetches are heavier and more rate-limit-sensitive, but
  // high enough to amortize TCP/TLS setup across a scene with dozens of glbs.
  const concurrency = options?.concurrency ?? 20

  const content = entity.content ?? []
  const contentByFile = new Map<string, string>()
  for (const c of content) contentByFile.set(c.file, c.hash)

  const contentsBaseUrl = normalizeContentsBaseUrl(contentServerUrl)

  const gltfEntries = content.filter((e) => GLTF_EXTENSIONS_SET.has(fileExtension(e.file)))
  const digests = new Map<string, string>()
  if (gltfEntries.length === 0) return digests

  const results = await mapBounded(gltfEntries, concurrency, async (entry) => {
    const ext = fileExtension(entry.file) as '.glb' | '.gltf'
    const bytes = await fetcher(`${contentsBaseUrl}${entry.hash}`)
    const uris = parseGltfDepRefs(bytes, ext)

    // Resolve URIs against entity content, dedup on (file, hash) — the glTF
    // URI layer already dedups by URI, but two distinct URIs could resolve to
    // the same content file via percent-encoding variants or path aliases.
    const seen = new Set<string>()
    const deps: Array<{ file: string; hash: string }> = []
    for (const uri of uris) {
      const resolved = resolveUriToContentFile(uri, entry.file)
      const hash = contentByFile.get(resolved)
      if (!hash) {
        throw new Error(
          `glTF ${entry.file} references "${uri}" (resolved to "${resolved}") which is not in the entity content`
        )
      }
      const key = `${resolved}\0${hash}`
      if (seen.has(key)) continue
      seen.add(key)
      deps.push({ file: resolved, hash })
    }

    return { hash: entry.hash, digest: computeDepsDigest(deps) }
  })

  for (const { hash, digest } of results) digests.set(hash, digest)
  return digests
}

type CheckAssetCacheParams = {
  entity: Pick<Entity, 'content'>
  abVersion: string
  buildTarget: string
  cdnBucket: string
  concurrency?: number
  /** Pre-computed per-asset deps digests keyed by asset hash. When supplied,
   * skips the re-computation that would otherwise happen inside
   * `checkAssetCache`. Callers that also need the digests (e.g. to pass to
   * Unity independently of whether the probe succeeded) should compute once
   * and pass through. Required in practice because computing digests involves
   * downloading glb bytes — the caller already has a catalyst URL in context. */
  depsDigestByHash?: ReadonlyMap<string, string>
  /** Catalyst URL used to download glb/gltf bytes when `depsDigestByHash` is
   * not supplied. Ignored when `depsDigestByHash` is provided. */
  contentServerUrl?: string
  /** Injectable fetcher for glb bytes — forwarded to `computePerAssetDigests`. */
  fetcher?: GltfFetcher
}

/**
 * Probe the canonical `{abVersion}/assets/{hash}_{buildTarget}` prefix for each valid
 * asset hash in the entity. Returns the partition of hashes (cached vs missing) plus
 * the subset of cached hashes whose file extension is safe to skip on the Unity side.
 */
export async function checkAssetCache(
  components: Pick<AppComponents, 'cdnS3' | 'logs' | 'metrics'>,
  params: CheckAssetCacheParams
): Promise<AssetCacheResult> {
  const { entity, abVersion, buildTarget, cdnBucket } = params
  // S3 HEAD is cheap and non-blocking; 50 saturates the probe phase for typical
  // scenes (dozens of assets) without exhausting the default HTTPS agent pool.
  const concurrency = params.concurrency ?? 50
  const logger = components.logs.getLogger('AssetReuse')

  let depsDigestByHash: ReadonlyMap<string, string>
  if (params.depsDigestByHash) {
    depsDigestByHash = params.depsDigestByHash
  } else {
    if (!params.contentServerUrl) {
      throw new Error('checkAssetCache: either depsDigestByHash or contentServerUrl must be supplied')
    }
    depsDigestByHash = await computePerAssetDigests(entity, params.contentServerUrl, { fetcher: params.fetcher })
  }

  type Probe = { hash: string; skippable: boolean; filename: string; key: string }
  const seen = new Set<string>()
  const probes: Probe[] = []
  for (const entry of entity.content ?? []) {
    const ext = fileExtension(entry.file)
    // Probe only the file kinds Unity actually emits as their own asset
    // bundle — glb/gltf and textures. `.bin` is excluded because Unity
    // inlines buffers into their referencing GLTF's bundle rather than
    // producing a standalone `{hash}_{target}` object, so probing would
    // always miss and permanently block the full-cache short-circuit.
    if (!PROBE_EXTENSIONS.has(ext)) continue
    if (seen.has(entry.hash)) continue
    seen.add(entry.hash)
    const filename = canonicalFilenameForAsset(entry.hash, ext, buildTarget, depsDigestByHash)
    probes.push({
      hash: entry.hash,
      skippable: UNITY_SKIPPABLE_EXTENSIONS.has(ext),
      filename,
      key: `${abVersion}/assets/${filename}`
    })
  }

  if (probes.length === 0) {
    return {
      cachedHashes: [],
      missingHashes: [],
      unitySkippableHashes: [],
      canonicalNameByHash: {},
      depsDigestByHash
    }
  }

  // Fast-path: skip S3 HEAD for hashes the hit-cache already confirmed as canonical.
  const hits: boolean[] = new Array(probes.length)
  const pendingIdx: number[] = []
  for (let i = 0; i < probes.length; i++) {
    if (probeHitCache.has(probes[i].key)) hits[i] = true
    else pendingIdx.push(i)
  }

  const hitCacheServed = probes.length - pendingIdx.length
  if (pendingIdx.length > 0) {
    const fetched = await mapBounded(pendingIdx, concurrency, (i) =>
      headExists(components.cdnS3, cdnBucket, probes[i].key)
    )
    for (let j = 0; j < pendingIdx.length; j++) {
      hits[pendingIdx[j]] = fetched[j]
      if (fetched[j]) probeHitCache.add(probes[pendingIdx[j]].key)
    }
  }

  if (hitCacheServed > 0) {
    components.metrics.increment(
      'ab_converter_asset_probe_hit_cache_total',
      { build_target: buildTarget, ab_version: abVersion },
      hitCacheServed
    )
  }
  if (pendingIdx.length > 0) {
    components.metrics.increment(
      'ab_converter_asset_probe_head_total',
      { build_target: buildTarget, ab_version: abVersion },
      pendingIdx.length
    )
  }

  const cachedHashes: string[] = []
  const missingHashes: string[] = []
  const unitySkippableHashes: string[] = []
  const canonicalNameByHash: Record<string, string> = {}

  for (let i = 0; i < probes.length; i++) {
    const { hash, skippable, filename } = probes[i]
    canonicalNameByHash[hash] = filename
    if (hits[i]) {
      cachedHashes.push(hash)
      if (skippable) unitySkippableHashes.push(hash)
    } else {
      missingHashes.push(hash)
    }
  }

  components.metrics.increment(
    'ab_converter_asset_cache_hits_total',
    { build_target: buildTarget, ab_version: abVersion },
    cachedHashes.length
  )
  components.metrics.increment(
    'ab_converter_asset_cache_misses_total',
    { build_target: buildTarget, ab_version: abVersion },
    missingHashes.length
  )

  logger.info('Asset cache probe complete', {
    total: probes.length,
    cached: cachedHashes.length,
    missing: missingHashes.length,
    unitySkippable: unitySkippableHashes.length,
    hitCacheServed,
    headRequests: pendingIdx.length,
    gltfAssetsDigested: depsDigestByHash.size
  } as any)

  return { cachedHashes, missingHashes, unitySkippableHashes, canonicalNameByHash, depsDigestByHash }
}

/**
 * Remove files whose hash is already canonicalized from the local output directory
 * so the existing `uploadDir` matcher uploads only new bundles. A file is considered
 * to belong to a cached hash when it is exactly the hash, or when its leading
 * `{hash}` segment (before the first `_` or `.`) is in `cachedHashes`. Runs in
 * O(entries + hashes) via a Set lookup on the extracted prefix.
 */
export async function purgeCachedBundlesFromOutput(
  outDirectory: string,
  cachedHashes: string[],
  logger: ILoggerComponent.ILogger
): Promise<number> {
  if (cachedHashes.length === 0) return 0
  const cached = new Set(cachedHashes)
  let entries: string[]
  try {
    entries = await fs.readdir(outDirectory)
  } catch {
    return 0
  }

  const toUnlink: string[] = []
  for (const entry of entries) {
    if (!cached.has(entry) && !cached.has(extractHashFromBundleName(entry) ?? '')) continue
    toUnlink.push(entry)
  }

  // Parallel unlink with a concurrency cap. Scenes with hundreds of cached assets
  // could otherwise fire that many simultaneous syscalls and hit ENFILE on
  // low-ulimit containers; 50 mirrors the S3 HEAD probe concurrency.
  const results = await mapBounded(toUnlink, 50, async (entry) => {
    try {
      await fs.unlink(path.join(outDirectory, entry))
      return true
    } catch (err: any) {
      logger.warn(`Failed to purge cached bundle ${entry}: ${err.message}`)
      return false
    }
  })

  return results.filter(Boolean).length
}
