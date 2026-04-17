import { Entity } from '@dcl/schemas'
import { ILoggerComponent } from '@well-known-components/interfaces'
import * as path from 'path'
import * as fs from 'fs/promises'
import { AppComponents } from '../types'
import { bufferExtensions, gltfExtensions, hasValidExtension } from './has-content-changed-task'

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

function fileExtension(file: string): string {
  const idx = file.lastIndexOf('.')
  return idx < 0 ? '' : file.substring(idx).toLowerCase()
}

function canonicalAssetKey(abVersion: string, hash: string, target: string): string {
  return `${abVersion}/assets/${hash}_${target}`
}

// Process-local cache of canonical keys confirmed to exist in S3. Canonical
// bundles are immutable once written (immutable Cache-Control, content-addressed
// path), so remembering a HIT across multiple conversions in the same worker is
// safe — the asset can't disappear underneath us. MISSES are intentionally NOT
// cached: another worker racing the same asset may have just uploaded it, and a
// stale-miss would force pointless Unity re-conversion.
//
// The entries are plain canonical keys (`{abVersion}/assets/{hash}_{target}`) so
// that a version bump or a different build target never returns a false positive.
// Arrow fields (not methods) so destructured references don't lose `this`.
// Exported for unit testing.
export const probeHitCache = {
  hits: new Map<string, number>(),
  ttlMs: 30 * 60_000, // 30 minutes
  maxSize: 20_000,
  has: function (key: string): boolean {
    const ts = probeHitCache.hits.get(key)
    if (ts === undefined) return false
    if (Date.now() - ts > probeHitCache.ttlMs) {
      probeHitCache.hits.delete(key)
      return false
    }
    return true
  },
  add: function (key: string) {
    // Simple bound: when full, drop the oldest insertion (Map preserves insertion
    // order, so `keys().next().value` is the oldest entry).
    if (probeHitCache.hits.size >= probeHitCache.maxSize) {
      const oldest = probeHitCache.hits.keys().next().value
      if (oldest !== undefined) probeHitCache.hits.delete(oldest)
    }
    probeHitCache.hits.set(key, Date.now())
  },
  clear: function () {
    probeHitCache.hits.clear()
  }
}

// Bundle filenames are `{hash}_{target}` optionally followed by `.br` / `.manifest`
// / `.manifest.br`. Extract the leading `{hash}` portion so callers can match
// against a cached-hash Set in O(1). Returns `null` when the name does not follow
// the hash-prefixed convention (e.g. generic Unity artifacts like `AssetBundles`).
function extractHashFromBundleName(name: string): string | null {
  const underscore = name.indexOf('_')
  const dot = name.indexOf('.')
  // pick the earlier delimiter that is actually present
  const firstDelim = underscore < 0 ? dot : dot < 0 ? underscore : Math.min(underscore, dot)
  if (firstDelim <= 0) return null
  return name.substring(0, firstDelim)
}

async function headExists(s3: AppComponents['cdnS3'], bucket: string, key: string): Promise<boolean> {
  try {
    await s3.headObject({ Bucket: bucket, Key: key }).promise()
    return true
  } catch (err: any) {
    if (err && (err.statusCode === 404 || err.code === 'NotFound' || err.code === 'NoSuchKey')) {
      return false
    }
    throw err
  }
}

export async function runBounded<T, R>(items: T[], concurrency: number, fn: (item: T) => Promise<R>): Promise<R[]> {
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
    const fetched = await runBounded(pendingIdx, concurrency, (i) => headExists(components.cdnS3, cdnBucket, keys[i]))
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
    'ab_converter_asset_cache_miss_total',
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

  // Parallel unlink — each syscall is cheap but node holds them serially otherwise.
  const results = await Promise.all(
    toUnlink.map(async (entry) => {
      try {
        await fs.unlink(path.join(outDirectory, entry))
        return true
      } catch (err: any) {
        logger.warn(`Failed to purge cached bundle ${entry}: ${err.message}`)
        return false
      }
    })
  )

  return results.filter(Boolean).length
}
