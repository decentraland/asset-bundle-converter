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
import { mapBounded } from './logic/asset-reuse'

type Manifest = {
  version?: string
  files?: string[]
  exitCode?: number | null
}

export type MigrationStats = {
  manifestsScanned: number
  manifestsKept: number
  manifestsSkipped: number
  bundlesProbed: number
  bundlesAlreadyCanonical: number
  bundlesCopied: number
  bundlesMissingSource: number
  errors: number
}

function emptyStats(): MigrationStats {
  return {
    manifestsScanned: 0,
    manifestsKept: 0,
    manifestsSkipped: 0,
    bundlesProbed: 0,
    bundlesAlreadyCanonical: 0,
    bundlesCopied: 0,
    bundlesMissingSource: 0,
    errors: 0
  }
}

// Matches bundle filenames Unity emits under an entity prefix. The leading segment
// is a CID; the trailing portion encodes target and optional variant suffixes.
// Exported for unit testing.
export function buildBundlePattern(target: string): RegExp {
  return new RegExp(`^[^/]+_${target}(\\.br|\\.manifest|\\.manifest\\.br)?$`)
}

// Manifests live at `manifest/{entityId}.json` (WebGL) or
// `manifest/{entityId}_{target}.json` (desktop). `_failed.json` sentinels are
// skipped. Exported for unit testing.
export function parseManifestKey(key: string): { entityId: string; target: string } | null {
  const base = key.replace(/^manifest\//, '').replace(/\.json$/, '')
  if (!base || base.endsWith('_failed')) return null

  const desktopMatch = base.match(/^(.+)_(windows|mac)$/)
  if (desktopMatch) return { entityId: desktopMatch[1], target: desktopMatch[2] }

  return { entityId: base, target: 'webgl' }
}

// Exported for unit testing.
export function isNotFound(err: any): boolean {
  return !!err && (err.statusCode === 404 || err.code === 'NotFound' || err.code === 'NoSuchKey')
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
  log?: (msg: string) => void
}

/**
 * Execute the migration loop against a pre-built S3 client. Separated from main()
 * so integration tests can drive it directly with mock-aws-s3 without going
 * through arg parsing + dotenv config + the real AWS SDK constructor.
 */
export async function runMigration(opts: RunMigrationOptions): Promise<MigrationStats> {
  const { s3, bucket, abVersion, target, dryRun, concurrency } = opts
  const log = opts.log ?? (() => {})
  const bundlePattern = buildBundlePattern(target)
  const canonicalPrefix = `${abVersion}/assets`
  const stats = emptyStats()

  for await (const obj of listManifests(s3, bucket)) {
    if (!obj.Key) continue
    stats.manifestsScanned++

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

    stats.manifestsKept++

    const sourcePrefix = `${abVersion}/${parsed.entityId}`
    const candidates = manifest.files.filter((f) => bundlePattern.test(f))

    await mapBounded(candidates, concurrency, async (filename) => {
      stats.bundlesProbed++
      const canonicalKey = `${canonicalPrefix}/${filename}`
      const sourceKey = `${sourcePrefix}/${filename}`

      try {
        await s3.headObject({ Bucket: bucket, Key: canonicalKey }).promise()
        stats.bundlesAlreadyCanonical++
        return
      } catch (err: any) {
        if (!isNotFound(err)) {
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
        if (isNotFound(err)) {
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
    '--dry-run': Boolean,
    '--concurrency': Number,
    '--help': Boolean
  })

  if (args['--help']) {
    console.log(`
Usage: yarn migrate --ab-version <v> --target <webgl|windows|mac> [options]

Copy existing {AB_VERSION}/{entityId}/{hash}_{target}* bundles into the
canonical {AB_VERSION}/assets/{hash}_{target}* layout.

Options:
  --ab-version <v>       AB_VERSION prefix (e.g. v48). Required.
  --target <t>           Build target to migrate (webgl|windows|mac). Required.
  --dry-run              Log intended copies, do not mutate the bucket.
  --concurrency <n>      Parallel probe+copy workers per manifest (default 50).
`)
    return
  }

  const abVersion = args['--ab-version']
  const target = args['--target']
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
    `Starting migration: bucket=${bucket} abVersion=${abVersion} target=${target} dryRun=${dryRun} concurrency=${concurrency}`
  )

  const startedAt = Date.now()

  const stats = await runMigration({
    s3,
    bucket,
    abVersion,
    target,
    dryRun,
    concurrency,
    log: (msg) => console.warn(msg)
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
