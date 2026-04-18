/* eslint-disable no-console */
// One-off migration: copy existing `{AB_VERSION}/{entityId}/{hash}_{target}*`
// bundles into the new canonical `{AB_VERSION}/assets/{hash}_{target}*` layout
// introduced by the per-asset reuse PR.
//
// Re-runnable and idempotent:
//   - Per-item errors are caught and counted (stats.errors); they don't abort
//     the enclosing manifest's remaining items or the outer manifest loop.
//   - Every candidate is HEAD-probed before copy, so already-canonical bundles
//     are a no-op.
//   - There is no checkpointing. If the process crashes mid-run, restart from
//     the beginning — the replay cost is ~1 HEAD per previously-processed
//     bundle plus one GetObject per previously-processed manifest, no
//     redundant copies. For a CDN bucket, that's effectively free.
//
// Same-bucket CopyObject is server-side (no egress through this process).
//
// Usage:
//   yarn build
//   yarn migrate --ab-version v48 --target windows
//   yarn migrate --ab-version v48 --target mac --dry-run
//
// Env: CDN_BUCKET (required), AWS_REGION (optional).

import arg from 'arg'
import AWS from 'aws-sdk'
import { createDotEnvConfigComponent } from '@well-known-components/env-config-provider'
import { canonicalFilename, computeDepsDigest, mapBounded } from './logic/asset-reuse'
import { getActiveEntity } from './logic/fetch-entity-by-pointer'
import { isS3NotFound } from './logic/s3-helpers'

type Manifest = {
  version?: string
  files?: string[]
  exitCode?: number | null
  contentServerUrl?: string
}

export type MigrationStats = {
  manifestsScanned: number
  manifestsKept: number
  manifestsSkipped: number
  manifestsMissingContentServer: number
  manifestsEntityFetchFailed: number
  bundlesProbed: number
  bundlesAlreadyCanonical: number
  bundlesCopied: number
  glbRenamedCount: number
  bundlesMissingSource: number
  errors: number
}

function emptyStats(): MigrationStats {
  return {
    manifestsScanned: 0,
    manifestsKept: 0,
    manifestsSkipped: 0,
    manifestsMissingContentServer: 0,
    manifestsEntityFetchFailed: 0,
    bundlesProbed: 0,
    bundlesAlreadyCanonical: 0,
    bundlesCopied: 0,
    glbRenamedCount: 0,
    bundlesMissingSource: 0,
    errors: 0
  }
}

function fileExtension(file: string): string {
  const idx = file.lastIndexOf('.')
  return idx < 0 ? '' : file.substring(idx).toLowerCase()
}

/**
 * Split a pre-PR bundle filename into `{hash, variant}` for a given target.
 * Pre-PR filenames are `{hash}_{target}(\.br|\.manifest|\.manifest\.br)?` where
 * `{hash}` has no `_` — tightening the capture to `[^_]+` excludes any
 * already-composite filename that somehow leaks in (those aren't migrateable
 * because their canonical copies come from the new converter, not this script).
 */
function splitBundleName(filename: string, target: string): { hash: string; variant: string } | null {
  const match = filename.match(new RegExp(`^([^_]+)_${target}(\\.br|\\.manifest|\\.manifest\\.br)?$`))
  if (!match) return null
  return { hash: match[1], variant: match[2] ?? '' }
}

/**
 * Regex matching the bundle filenames Unity emits for a given target.
 *
 * Shape: `{hash}_{target}` optionally followed by `.br`, `.manifest`, or
 * `.manifest.br`. The leading segment is any CID-shaped prefix; the trailing
 * portion encodes target + variant. Generic artifacts like `AssetBundles`
 * don't match because they lack the `_{target}` segment.
 *
 * Exported for unit testing.
 *
 * @param target - Build target — one of `webgl` / `windows` / `mac`.
 */
export function buildBundlePattern(target: string): RegExp {
  return new RegExp(`^[^/]+_${target}(\\.br|\\.manifest|\\.manifest\\.br)?$`)
}

/**
 * Parse an S3 manifest key into `{ entityId, target }`.
 *
 * Manifests live at `manifest/{entityId}.json` (WebGL default) or
 * `manifest/{entityId}_{target}.json` (Windows/Mac). `_failed.json` sentinels
 * are skipped entirely — the migration doesn't touch failed conversions.
 *
 * Exported for unit testing.
 *
 * @param key - S3 object key (e.g. `manifest/bafkrei123_windows.json`).
 * @returns `{ entityId, target }` on success; `null` when the key is empty,
 *   unrecognized, or points at a `_failed` sentinel.
 */
export function parseManifestKey(key: string): { entityId: string; target: string } | null {
  const base = key.replace(/^manifest\//, '').replace(/\.json$/, '')
  if (!base || base.endsWith('_failed')) return null

  const desktopMatch = base.match(/^(.+)_(windows|mac)$/)
  if (desktopMatch) return { entityId: desktopMatch[1], target: desktopMatch[2] }

  return { entityId: base, target: 'webgl' }
}

async function* listManifests(s3: AWS.S3, bucket: string): AsyncGenerator<AWS.S3.Object> {
  let ContinuationToken: string | undefined
  do {
    const res: AWS.S3.ListObjectsV2Output = await s3
      .listObjectsV2({ Bucket: bucket, Prefix: 'manifest/', ContinuationToken })
      .promise()
    for (const obj of res.Contents ?? []) yield obj
    ContinuationToken = res.IsTruncated ? res.NextContinuationToken : undefined
  } while (ContinuationToken)
}

export type RunMigrationOptions = {
  s3: AWS.S3
  bucket: string
  abVersion: string
  target: string
  dryRun: boolean
  concurrency: number
  /** Receives individual error messages (per-manifest / per-bundle). */
  log?: (msg: string) => void
  /** Fires every `progressInterval` manifests with a live stats snapshot.
   * Useful for multi-hour migration runs — without it the operator sees
   * nothing until completion. Tests typically omit it. */
  onProgress?: (stats: MigrationStats) => void
  /** How often to call `onProgress`, measured in manifests scanned.
   * Default 100. */
  progressInterval?: number
  /** Catalyst fetcher — normally `getActiveEntity`; tests pass a stub so they
   * don't depend on `node-fetch`. Must return the entity's `.content` array. */
  fetchEntity?: (entityId: string, contentServerUrl: string) => Promise<{ content: { file: string; hash: string }[] }>
  /** Fallback catalyst URL used when a manifest body doesn't carry its own
   * `contentServerUrl`. Pre-PR manifests were written before we started
   * stamping that field, so for a backfill run the operator should pass
   * `--content-server-url https://peer.decentraland.org/content` — otherwise
   * every pre-PR manifest is skipped. Manifest-embedded value wins if both
   * are present (the manifest was produced against a specific catalyst). */
  contentServerUrl?: string
}

/**
 * Execute the migration loop against a pre-built S3 client. Separated from main()
 * so integration tests can drive it directly with mock-aws-s3 without going
 * through arg parsing + dotenv config + the real AWS SDK constructor.
 */
export async function runMigration(opts: RunMigrationOptions): Promise<MigrationStats> {
  const { s3, bucket, abVersion, target, dryRun, concurrency } = opts
  const log = opts.log ?? (() => {})
  const onProgress = opts.onProgress
  const progressInterval = opts.progressInterval ?? 100
  const fetchEntity = opts.fetchEntity ?? getActiveEntity
  const bundlePattern = buildBundlePattern(target)
  const canonicalPrefix = `${abVersion}/assets`
  const stats = emptyStats()

  for await (const obj of listManifests(s3, bucket)) {
    if (!obj.Key) continue
    stats.manifestsScanned++

    // Periodic progress callback — lets long migration runs surface liveness
    // signal without flooding logs on every manifest.
    if (onProgress && stats.manifestsScanned % progressInterval === 0) {
      onProgress({ ...stats })
    }

    const parsed = parseManifestKey(obj.Key)
    if (!parsed || parsed.target !== target) {
      stats.manifestsSkipped++
      continue
    }

    let manifest: Manifest
    try {
      const res = await s3.getObject({ Bucket: bucket, Key: obj.Key }).promise()
      const body = res.Body?.toString()
      if (!body) {
        stats.manifestsSkipped++
        continue
      }
      manifest = JSON.parse(body) as Manifest
    } catch (err: any) {
      log(`[${obj.Key}] failed to read/parse manifest: ${err.message}`)
      stats.errors++
      continue
    }

    if (manifest.version !== abVersion || manifest.exitCode !== 0 || !Array.isArray(manifest.files)) {
      stats.manifestsSkipped++
      continue
    }

    // Canonical keying for glb/gltf bundles includes the entity's deps digest.
    // Without the entity's content list we can't tell glb from leaf, so skip
    // the manifest rather than mass-migrate to paths future probes won't hit.
    // Pre-PR manifests don't carry `contentServerUrl` — rely on the CLI-supplied
    // fallback so backfill runs on historical manifests still work.
    const catalystUrl = manifest.contentServerUrl || opts.contentServerUrl
    if (!catalystUrl) {
      stats.manifestsMissingContentServer++
      continue
    }

    let extByHash: Map<string, string>
    let depsDigest: string
    try {
      const entity = await fetchEntity(parsed.entityId, catalystUrl)
      extByHash = new Map<string, string>()
      for (const c of entity.content ?? []) extByHash.set(c.hash, fileExtension(c.file))
      depsDigest = computeDepsDigest(entity.content ?? [])
    } catch (err: any) {
      log(`[${obj.Key}] failed to fetch entity: ${err.message}`)
      stats.manifestsEntityFetchFailed++
      continue
    }

    stats.manifestsKept++

    const sourcePrefix = `${abVersion}/${parsed.entityId}`
    const candidates = manifest.files.filter((f) => bundlePattern.test(f))

    await mapBounded(candidates, concurrency, async (filename) => {
      stats.bundlesProbed++

      // Source file on pre-PR entity-scoped layout retains the bare filename
      // Unity originally produced — we only rename on the canonical destination.
      const sourceKey = `${sourcePrefix}/${filename}`

      const parts = splitBundleName(filename, target)
      const ext = parts ? (extByHash.get(parts.hash) ?? '') : ''
      const destFilename = parts
        ? `${canonicalFilename(parts.hash, ext, target, depsDigest)}${parts.variant}`
        : filename
      const canonicalKey = `${canonicalPrefix}/${destFilename}`
      if (destFilename !== filename) stats.glbRenamedCount++

      try {
        await s3.headObject({ Bucket: bucket, Key: canonicalKey }).promise()
        stats.bundlesAlreadyCanonical++
        return
      } catch (err: any) {
        if (!isS3NotFound(err)) {
          log(`HEAD ${canonicalKey} failed: ${err.message}`)
          stats.errors++
          return
        }
      }

      if (dryRun) {
        stats.bundlesCopied++ // counted as "would copy"
        return
      }

      try {
        await s3
          .copyObject({
            Bucket: bucket,
            CopySource: `/${bucket}/${encodeURIComponent(sourceKey).replace(/%2F/g, '/')}`,
            Key: canonicalKey,
            MetadataDirective: 'COPY',
            ACL: 'public-read'
          })
          .promise()
        stats.bundlesCopied++
      } catch (err: any) {
        if (isS3NotFound(err)) {
          // Manifest listed a file that no longer exists at the entity prefix —
          // likely a stale manifest from a partial cleanup. Skip quietly.
          stats.bundlesMissingSource++
        } else {
          log(`COPY ${sourceKey} -> ${canonicalKey} failed: ${err.message}`)
          stats.errors++
        }
      }
    })
  }

  return stats
}

async function main() {
  const args = arg({
    '--ab-version': String,
    '--target': String,
    '--content-server-url': String,
    '--dry-run': Boolean,
    '--concurrency': Number,
    '--help': Boolean
  })

  if (args['--help']) {
    console.log(`
Usage: yarn migrate --ab-version <v> --target <webgl|windows|mac> [options]

Copy existing {AB_VERSION}/{entityId}/{hash}_{target}* bundles into the
canonical {AB_VERSION}/assets/ layout. glb/gltf bundles land at
{hash}_{depsDigest}_{target}; bins and textures at {hash}_{target}.

Options:
  --ab-version <v>            AB_VERSION prefix (e.g. v48). Required.
  --target <t>                Build target (webgl|windows|mac). Required.
  --content-server-url <url>  Fallback catalyst URL used when a manifest's body
                              is missing contentServerUrl. Required for backfill
                              of pre-PR-#258 manifests (they predate that
                              field). Typically https://peer.decentraland.org/content.
  --dry-run                   Log intended copies, do not mutate the bucket.
  --concurrency <n>           Parallel probe+copy workers per manifest (default 50).
`)
    return
  }

  const abVersion = args['--ab-version']
  const target = args['--target']
  const contentServerUrl = args['--content-server-url']
  const dryRun = args['--dry-run'] === true
  const concurrency = args['--concurrency'] ?? 50

  if (!abVersion) throw new Error('Missing --ab-version')
  if (!target || !['webgl', 'windows', 'mac'].includes(target)) {
    throw new Error('Missing or invalid --target (webgl|windows|mac)')
  }

  const config = await createDotEnvConfigComponent({ path: ['.env.default', '.env'] })
  const awsRegion = await config.getString('AWS_REGION')
  if (awsRegion) AWS.config.update({ region: awsRegion })
  const bucket = await config.getString('CDN_BUCKET')
  if (!bucket) throw new Error('CDN_BUCKET is not set')

  const s3 = new AWS.S3({})

  console.log(
    `Starting migration: bucket=${bucket} abVersion=${abVersion} target=${target} dryRun=${dryRun} concurrency=${concurrency} contentServerUrl=${contentServerUrl ?? '(from manifest)'}`
  )

  const startedAt = Date.now()

  const stats = await runMigration({
    s3,
    bucket,
    abVersion,
    target,
    dryRun,
    concurrency,
    contentServerUrl,
    log: (msg) => console.warn(msg),
    onProgress: (snapshot) => {
      const elapsedSec = ((Date.now() - startedAt) / 1000).toFixed(1)
      console.log(`[${elapsedSec}s] progress: ${JSON.stringify(snapshot)}`)
    }
  })

  const elapsedSec = ((Date.now() - startedAt) / 1000).toFixed(1)
  console.log(`\nMigration ${dryRun ? '(DRY RUN) ' : ''}complete in ${elapsedSec}s`)
  console.log(JSON.stringify(stats, null, 2))
}

// Only execute when run directly (`node dist/migrate-to-canonical.js`). Leaves the
// module importable from tests without firing off a real migration.
if (require.main === module) {
  main().catch((err) => {
    console.error(err)
    process.exit(1)
  })
}
