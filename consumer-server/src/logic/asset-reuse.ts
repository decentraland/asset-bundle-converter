import { Entity } from '@dcl/schemas'
import { ILoggerComponent } from '@well-known-components/interfaces'
import * as path from 'path'
import * as fs from 'fs/promises'
import { AppComponents } from '../types'
import { bufferExtensions, gltfExtensions, hasValidExtension } from './has-content-changed-task'
import { isS3NotFound } from './s3-helpers'

// Unity-side extensions whose bundles have no inbound dependencies from other
// assets, so the converter can safely skip downloading & re-building them when the
// canonical bundle already exists. Textures are intentionally excluded — they can
// still be referenced from within a non-cached GLTF during import, so we keep
// downloading them regardless of cache status.
const UNITY_SKIPPABLE_EXTENSIONS = new Set<string>([...gltfExtensions, ...bufferExtensions])

export type AssetCacheResult = {
  cachedHashes: string[]
  missingHashes: string[]
  // Hashes Unity can safely skip building. Subset of cachedHashes limited to file
  // extensions whose bundles have no inbound Unity dependencies from other assets.
  unitySkippableHashes: string[]
}

/** Extract the lowercase file extension (including the leading `.`) from a
 * filename. Returns `''` when the name has no `.`. */
function fileExtension(file: string): string {
  const idx = file.lastIndexOf('.')
  return idx < 0 ? '' : file.substring(idx).toLowerCase()
}

/** Build the canonical S3 key (`{abVersion}/assets/{hash}_{target}`) the
 * per-asset reuse scheme writes to. The cache probe HEADs exactly this. */
function canonicalAssetKey(abVersion: string, hash: string, target: string): string {
  return `${abVersion}/assets/${hash}_${target}`
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

type CheckAssetCacheParams = {
  entity: Pick<Entity, 'content'>
  abVersion: string
  buildTarget: string
  cdnBucket: string
  concurrency?: number
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

  type Probe = { hash: string; skippable: boolean }
  const seen = new Set<string>()
  const probes: Probe[] = []
  for (const entry of entity.content ?? []) {
    if (!hasValidExtension(entry.file)) continue
    if (seen.has(entry.hash)) continue
    seen.add(entry.hash)
    const ext = fileExtension(entry.file)
    probes.push({ hash: entry.hash, skippable: UNITY_SKIPPABLE_EXTENSIONS.has(ext) })
  }

  if (probes.length === 0) {
    return { cachedHashes: [], missingHashes: [], unitySkippableHashes: [] }
  }

  // Fast-path: skip S3 HEAD for hashes the hit-cache already confirmed as canonical.
  const keys = probes.map((p) => canonicalAssetKey(abVersion, p.hash, buildTarget))
  const hits: boolean[] = new Array(probes.length)
  const pendingIdx: number[] = []
  for (let i = 0; i < probes.length; i++) {
    if (probeHitCache.has(keys[i])) hits[i] = true
    else pendingIdx.push(i)
  }

  const hitCacheServed = probes.length - pendingIdx.length
  if (pendingIdx.length > 0) {
    const fetched = await mapBounded(pendingIdx, concurrency, (i) => headExists(components.cdnS3, cdnBucket, keys[i]))
    for (let j = 0; j < pendingIdx.length; j++) {
      hits[pendingIdx[j]] = fetched[j]
      if (fetched[j]) probeHitCache.add(keys[pendingIdx[j]])
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

  for (let i = 0; i < probes.length; i++) {
    const { hash, skippable } = probes[i]
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
    headRequests: pendingIdx.length
  } as any)

  return { cachedHashes, missingHashes, unitySkippableHashes }
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
