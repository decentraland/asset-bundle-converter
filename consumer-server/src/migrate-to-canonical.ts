/* eslint-disable no-console */
// One-off migration: copy existing `{AB_VERSION}/{entityId}/{hash}_{target}*`
// bundles into the new canonical `{AB_VERSION}/assets/{hash}_{target}*` layout
// introduced by the per-asset reuse PR. Re-runnable and idempotent — each target
// object is probed with HEAD before copy, and same-bucket CopyObject is
// server-side (no egress through this process).
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
import { runBounded } from './logic/asset-reuse'

type Manifest = {
  version?: string
  files?: string[]
  exitCode?: number | null
}

type Stats = {
  manifestsScanned: number
  manifestsKept: number
  manifestsSkipped: number
  bundlesProbed: number
  bundlesAlreadyCanonical: number
  bundlesCopied: number
  bundlesMissingSource: number
  errors: number
}

// Matches bundle filenames Unity emits under an entity prefix. The leading segment
// is a CID; the trailing portion encodes target and optional variant suffixes.
function buildBundlePattern(target: string): RegExp {
  return new RegExp(`^[^/]+_${target}(\\.br|\\.manifest|\\.manifest\\.br)?$`)
}

// Manifests live at `manifest/{entityId}.json` (WebGL) or
// `manifest/{entityId}_{target}.json` (desktop). `_failed.json` sentinels are
// skipped.
function parseManifestKey(key: string): { entityId: string; target: string } | null {
  const base = key.replace(/^manifest\//, '').replace(/\.json$/, '')
  if (!base || base.endsWith('_failed')) return null

  const desktopMatch = base.match(/^(.+)_(windows|mac)$/)
  if (desktopMatch) return { entityId: desktopMatch[1], target: desktopMatch[2] }

  return { entityId: base, target: 'webgl' }
}

function isNotFound(err: any): boolean {
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
  const bundlePattern = buildBundlePattern(target)
  const canonicalPrefix = `${abVersion}/assets`

  const stats: Stats = {
    manifestsScanned: 0,
    manifestsKept: 0,
    manifestsSkipped: 0,
    bundlesProbed: 0,
    bundlesAlreadyCanonical: 0,
    bundlesCopied: 0,
    bundlesMissingSource: 0,
    errors: 0
  }

  console.log(
    `Starting migration: bucket=${bucket} abVersion=${abVersion} target=${target} dryRun=${dryRun} concurrency=${concurrency}`
  )

  const startedAt = Date.now()
  const progressInterval = 100

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
      console.warn(`[${obj.Key}] failed to read/parse manifest: ${err.message}`)
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

    await runBounded(candidates, concurrency, async (filename) => {
      stats.bundlesProbed++
      const canonicalKey = `${canonicalPrefix}/${filename}`
      const sourceKey = `${sourcePrefix}/${filename}`

      try {
        await s3.headObject({ Bucket: bucket, Key: canonicalKey }).promise()
        stats.bundlesAlreadyCanonical++
        return
      } catch (err: any) {
        if (!isNotFound(err)) {
          console.warn(`HEAD ${canonicalKey} failed: ${err.message}`)
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
          console.warn(`COPY ${sourceKey} -> ${canonicalKey} failed: ${err.message}`)
          stats.errors++
        }
      }
    })

    if (stats.manifestsScanned % progressInterval === 0) {
      const elapsedSec = ((Date.now() - startedAt) / 1000).toFixed(1)
      console.log(`[${elapsedSec}s] progress: ${JSON.stringify(stats)}`)
    }
  }

  const elapsedSec = ((Date.now() - startedAt) / 1000).toFixed(1)
  console.log(`\nMigration ${dryRun ? '(DRY RUN) ' : ''}complete in ${elapsedSec}s`)
  console.log(JSON.stringify(stats, null, 2))
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
