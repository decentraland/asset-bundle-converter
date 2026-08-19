/* eslint-disable no-console */
// Destructive ops script with two modes:
//
//   --mode assets (default)
//     Bulk-delete every object under `{AB_VERSION}/assets/`. The canonical
//     prefix is shared by every BUILD_TARGET that has run against this
//     AB_VERSION (webgl + windows + mac all land under the same
//     `{AB_VERSION}/assets/`). Wiping the whole prefix invalidates every
//     reusable bundle for that version across all pools — scenes whose
//     top-level manifests resolve to canonical paths will 404 through the
//     CDN until live conversions repopulate. Use `--target` to scope to a
//     single build target.
//
//   --mode manifests
//     Targeted-delete the `manifest/{entityId}*.json` keys for a list of
//     scene entity IDs, so the converter treats those scenes as never having
//     been converted. By default deletes all four candidate keys per ID
//     (webgl/windows/mac success + `_failed` sentinel); narrow with
//     `--target` to one build target's success manifest only.
//
// Defaults to dry-run. `--execute` is required to actually mutate.
//
// Usage:
//   yarn build
//   yarn delete-canonical-assets --ab-version v48                       # dry-run, all targets
//   yarn delete-canonical-assets --ab-version v48 --target windows      # dry-run, windows only
//   yarn delete-canonical-assets --ab-version v48 --target windows --execute
//   yarn delete-canonical-assets --mode manifests --entity-ids bafkreiexample1,bafkreiexample2
//   yarn delete-canonical-assets --mode manifests --entity-ids-file ./scenes.txt --execute
//
// Env: CDN_BUCKET (required), AWS_REGION (optional).

import { promises as fs } from 'fs'
import arg from 'arg'
import AWS from 'aws-sdk'
import { createDotEnvConfigComponent } from '@well-known-components/env-config-provider'

export type DeleteStats = {
  objectsScanned: number
  objectsMatched: number
  objectsDeleted: number
  bytesMatched: number
  errors: number
}

function emptyStats(): DeleteStats {
  return {
    objectsScanned: 0,
    objectsMatched: 0,
    objectsDeleted: 0,
    bytesMatched: 0,
    errors: 0
  }
}

/**
 * Returns the regex used to filter canonical bundle filenames for a given
 * build target. Matches both the leaf form (`{hash}_{target}`) and the
 * per-glb form (`{hash}_{depsDigest}_{target}`), with optional `.br`,
 * `.manifest`, and `.manifest.br` variants.
 *
 * Exported for unit testing.
 */
export function buildTargetFilter(target: string): RegExp {
  return new RegExp(`_${target}(\\.br|\\.manifest|\\.manifest\\.br)?$`)
}

async function* listAssets(s3: AWS.S3, bucket: string, prefix: string): AsyncGenerator<AWS.S3.Object> {
  let ContinuationToken: string | undefined
  do {
    const res: AWS.S3.ListObjectsV2Output = await s3
      .listObjectsV2({ Bucket: bucket, Prefix: prefix, ContinuationToken })
      .promise()
    for (const obj of res.Contents ?? []) yield obj
    ContinuationToken = res.IsTruncated ? res.NextContinuationToken : undefined
  } while (ContinuationToken)
}

export type RunDeletionOptions = {
  s3: AWS.S3
  bucket: string
  abVersion: string
  /** Optional target filter. When omitted, every object under the canonical
   * prefix is in scope — including all build targets that share the prefix. */
  target?: string
  /** When false, the script logs intended deletes and never calls deleteObjects. */
  execute: boolean
  /** Receives individual error / sample messages. */
  log?: (msg: string) => void
  /** Fires every `progressInterval` scanned objects with a live snapshot.
   * Long runs against large prefixes need liveness signal. */
  onProgress?: (stats: DeleteStats) => void
  progressInterval?: number
  /** Cap on how many sample keys to log in dry-run mode. Avoids dumping
   * tens of thousands of keys to stdout while still giving the operator
   * a feel for what's matched. */
  sampleLimit?: number
}

/** S3 deleteObjects accepts at most 1000 keys per request. */
const DELETE_BATCH_SIZE = 1000

export async function runDeletion(opts: RunDeletionOptions): Promise<DeleteStats> {
  const { s3, bucket, abVersion, target, execute } = opts
  const log = opts.log ?? (() => {})
  const onProgress = opts.onProgress
  const progressInterval = opts.progressInterval ?? 1000
  const sampleLimit = opts.sampleLimit ?? 20

  const prefix = `${abVersion}/assets/`
  const filter = target ? buildTargetFilter(target) : null
  const stats = emptyStats()
  const samples: string[] = []
  let batch: AWS.S3.ObjectIdentifier[] = []

  const flushBatch = async () => {
    if (batch.length === 0) return
    try {
      const res = await s3.deleteObjects({ Bucket: bucket, Delete: { Objects: batch, Quiet: true } }).promise()
      stats.objectsDeleted += batch.length - (res.Errors?.length ?? 0)
      if (res.Errors && res.Errors.length > 0) {
        stats.errors += res.Errors.length
        for (const e of res.Errors) log(`[delete-error] ${e.Key}: ${e.Code} ${e.Message}`)
      }
    } catch (err: any) {
      stats.errors += batch.length
      log(`[delete-batch-error] ${err.message}`)
    }
    batch = []
  }

  for await (const obj of listAssets(s3, bucket, prefix)) {
    if (!obj.Key) continue
    stats.objectsScanned++

    if (onProgress && stats.objectsScanned % progressInterval === 0) {
      onProgress({ ...stats })
    }

    if (filter) {
      const filename = obj.Key.slice(prefix.length)
      if (!filter.test(filename)) continue
    }

    stats.objectsMatched++
    stats.bytesMatched += obj.Size ?? 0

    if (samples.length < sampleLimit) samples.push(obj.Key)

    if (execute) {
      batch.push({ Key: obj.Key })
      if (batch.length >= DELETE_BATCH_SIZE) await flushBatch()
    }
  }

  if (execute) await flushBatch()

  log(`Sample of matched keys (up to ${sampleLimit}):`)
  for (const k of samples) log(`  ${k}`)

  return stats
}

export type ManifestDeleteStats = {
  entityIdsProcessed: number
  entityIdsInvalid: number
  candidatesProbed: number
  manifestsFound: number
  manifestsMissing: number
  manifestsDeleted: number
  errors: number
}

function emptyManifestStats(): ManifestDeleteStats {
  return {
    entityIdsProcessed: 0,
    entityIdsInvalid: 0,
    candidatesProbed: 0,
    manifestsFound: 0,
    manifestsMissing: 0,
    manifestsDeleted: 0,
    errors: 0
  }
}

/**
 * Bare-CID shape for scene entity IDs. Entity IDs are interpolated into
 * `manifest/{entityId}*.json` S3 keys, so restricting them to `[a-zA-Z0-9]`
 * mirrors the orchestrator's path/key-injection guard
 * (`conversion-orchestrator/component.ts`) and the catalyst adapter's CID
 * check. An S3 key is literal (a stray `../` can't traverse out of the
 * bucket), but a malformed line would still spend HEAD/DELETE calls probing
 * meaningless keys — reject it up front instead. Exported for unit testing.
 */
export const ENTITY_ID_RE = /^[a-zA-Z0-9]+$/

/**
 * Build the candidate manifest keys for a scene entityId.
 *
 * Mirrors `manifestKeyForEntity` in `logic/conversion-task.ts`: webgl is the
 * default `manifest/{id}.json` (no target suffix), windows/mac get
 * `manifest/{id}_{target}.json`. The `_failed.json` sentinel is shared
 * across targets and is only included when no target filter is set
 * (narrowing to a single target shouldn't blow away the failure marker
 * other targets may still rely on).
 *
 * Exported for unit testing.
 */
export function manifestCandidateKeys(entityId: string, target?: string): string[] {
  if (target === 'webgl') return [`manifest/${entityId}.json`]
  if (target === 'windows' || target === 'mac') return [`manifest/${entityId}_${target}.json`]
  return [
    `manifest/${entityId}.json`,
    `manifest/${entityId}_windows.json`,
    `manifest/${entityId}_mac.json`,
    `manifest/${entityId}_failed.json`
  ]
}

/** Parse an entity-ids file: one ID per line, blank lines and `#` comments
 * ignored. Whitespace trimmed. Empty result is a caller error to handle. */
export function parseEntityIdsFile(contents: string): string[] {
  return contents
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'))
}

export type RunManifestDeletionOptions = {
  s3: AWS.S3
  bucket: string
  entityIds: string[]
  /** Optional. Without it, every per-target success manifest plus the
   * `_failed` sentinel are candidates per entity. */
  target?: string
  execute: boolean
  log?: (msg: string) => void
  /** Parallelism for HEAD probes. Each entity has up to 4 candidates;
   * with default 50 the script issues at most 200 in-flight HEADs. */
  concurrency?: number
  /** Cap on logged sample of found-keys in dry-run mode. */
  sampleLimit?: number
}

const DEFAULT_HEAD_CONCURRENCY = 50

async function probeKey(
  s3: AWS.S3,
  bucket: string,
  key: string
): Promise<{ key: string; exists: boolean; error?: string }> {
  try {
    await s3.headObject({ Bucket: bucket, Key: key }).promise()
    return { key, exists: true }
  } catch (err: any) {
    // S3 returns NotFound / 404 for missing objects — treat as "not present"
    // (not an error). Anything else (403, network) is a real probe failure
    // and bubbles up as `error` so the operator sees it in the stats.
    if (err?.code === 'NotFound' || err?.statusCode === 404) {
      return { key, exists: false }
    }
    return { key, exists: false, error: `${err?.code ?? 'Error'}: ${err?.message ?? String(err)}` }
  }
}

async function runWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T) => Promise<R>
): Promise<R[]> {
  const results: R[] = new Array(items.length)
  let cursor = 0
  const runners = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (true) {
      const i = cursor++
      if (i >= items.length) return
      results[i] = await worker(items[i])
    }
  })
  await Promise.all(runners)
  return results
}

export async function runManifestDeletion(opts: RunManifestDeletionOptions): Promise<ManifestDeleteStats> {
  const { s3, bucket, entityIds, target, execute } = opts
  const log = opts.log ?? (() => {})
  const concurrency = opts.concurrency ?? DEFAULT_HEAD_CONCURRENCY
  const sampleLimit = opts.sampleLimit ?? 50
  const stats = emptyManifestStats()

  // Dedupe + drop empties so a sloppy input file doesn't multiply HEADs or
  // double-count stats.
  const uniqueIds = Array.from(new Set(entityIds.map((id) => id.trim()).filter((id) => id.length > 0)))

  const candidates: string[] = []
  for (const id of uniqueIds) {
    // Reject anything that isn't a bare CID before it reaches an S3 key.
    // Skip-and-warn rather than abort the whole batch on one bad line.
    if (!ENTITY_ID_RE.test(id)) {
      stats.entityIdsInvalid++
      log(`[invalid-entity-id] skipping ${JSON.stringify(id.slice(0, 80))} — not a bare CID`)
      continue
    }
    stats.entityIdsProcessed++
    for (const key of manifestCandidateKeys(id, target)) candidates.push(key)
  }

  stats.candidatesProbed = candidates.length

  const probeResults = await runWithConcurrency(candidates, concurrency, (key) => probeKey(s3, bucket, key))

  const foundKeys: string[] = []
  for (const r of probeResults) {
    if (r.error) {
      stats.errors++
      log(`[probe-error] ${r.key}: ${r.error}`)
      continue
    }
    if (r.exists) {
      stats.manifestsFound++
      foundKeys.push(r.key)
    } else {
      stats.manifestsMissing++
    }
  }

  log(`Sample of manifests found (up to ${sampleLimit}):`)
  for (const k of foundKeys.slice(0, sampleLimit)) log(`  ${k}`)

  if (execute && foundKeys.length > 0) {
    for (let i = 0; i < foundKeys.length; i += DELETE_BATCH_SIZE) {
      const batch = foundKeys.slice(i, i + DELETE_BATCH_SIZE).map((Key) => ({ Key }))
      try {
        const res = await s3.deleteObjects({ Bucket: bucket, Delete: { Objects: batch, Quiet: true } }).promise()
        stats.manifestsDeleted += batch.length - (res.Errors?.length ?? 0)
        if (res.Errors && res.Errors.length > 0) {
          stats.errors += res.Errors.length
          for (const e of res.Errors) log(`[delete-error] ${e.Key}: ${e.Code} ${e.Message}`)
        }
      } catch (err: any) {
        stats.errors += batch.length
        log(`[delete-batch-error] ${err.message}`)
      }
    }
  }

  return stats
}

async function main() {
  const args = arg({
    '--mode': String,
    '--ab-version': String,
    '--target': String,
    '--execute': Boolean,
    '--bucket': String,
    '--aws-region': String,
    '--aws-access-key-id': String,
    '--aws-secret-access-key': String,
    '--aws-session-token': String,
    '--entity-ids': String,
    '--entity-ids-file': String,
    '--help': Boolean
  })

  if (args['--help']) {
    console.log(`Usage: yarn delete-canonical-assets [--mode assets|manifests] [options]

Modes:
  --mode assets (default)
    Bulk-delete every object under {AB_VERSION}/assets/. Required: --ab-version.
    Optional: --target to scope to one build target.

  --mode manifests
    Targeted-delete manifest/{entityId}*.json keys for a list of scene IDs.
    Required: one of --entity-ids or --entity-ids-file. Optional: --target.

Defaults to dry-run; pass --execute to actually delete.

Blast radius (assets mode): scenes whose top-level manifest resolves to
canonical paths will 404 through the CDN until live conversions repopulate.
The canonical prefix is shared across build targets, so omitting --target
deletes every target's canonical bundles for this AB_VERSION.

Blast radius (manifests mode): a deleted manifest makes the converter treat
the scene as never converted. The next conversion job for that entityId
will run Unity from scratch and re-upload manifests. Existing canonical /
entity-scoped bundles are NOT touched by manifests mode.

Options:
  --mode <m>                 assets|manifests (default: assets).
  --ab-version <v>           AB_VERSION prefix (e.g. v48). Required for assets mode.
  --target <t>               Build target filter (webgl|windows|mac). Optional.
                             In assets mode: filters by canonical filename suffix.
                             In manifests mode: deletes only that target's manifest
                             key (omit to delete all target manifests + the
                             _failed sentinel for each entity).
  --entity-ids <a,b,c>       Comma-separated scene entity IDs (manifests mode).
  --entity-ids-file <path>   File of entity IDs, one per line. Blank lines and
                             lines starting with '#' are ignored. Combined with
                             --entity-ids and deduped.
  --execute                  Perform deletes. Without this flag the script only
                             reports what it would delete.
  --bucket <name>            Override CDN_BUCKET from env / .env files.
  --aws-region <region>      Override AWS_REGION from env / .env files.
  --aws-access-key-id <id>   AWS access key. WARNING: visible in 'ps' and shell
                             history — prefer the AWS_ACCESS_KEY_ID env var
                             (the SDK picks it up automatically) unless you
                             explicitly need a one-off CLI override.
  --aws-secret-access-key <secret>
                             AWS secret. Same warning as above; prefer
                             AWS_SECRET_ACCESS_KEY in the environment.
  --aws-session-token <token>
                             Optional STS session token (for temporary
                             credentials).

If --aws-access-key-id / --aws-secret-access-key are omitted, the SDK falls
back to its default credential chain (env vars, shared credentials file,
IAM role, etc.) — that's the recommended path.
`)
    return
  }

  const mode = args['--mode'] ?? 'assets'
  const abVersion = args['--ab-version']
  const target = args['--target']
  const execute = args['--execute'] === true
  const cliAccessKeyId = args['--aws-access-key-id']
  const cliSecretAccessKey = args['--aws-secret-access-key']
  const cliSessionToken = args['--aws-session-token']
  const entityIdsArg = args['--entity-ids']
  const entityIdsFile = args['--entity-ids-file']

  if (mode !== 'assets' && mode !== 'manifests') {
    throw new Error(`Invalid --mode '${mode}' (expected assets|manifests)`)
  }
  if (target && !['webgl', 'windows', 'mac'].includes(target)) {
    throw new Error('Invalid --target (webgl|windows|mac)')
  }
  if (Boolean(cliAccessKeyId) !== Boolean(cliSecretAccessKey)) {
    throw new Error('--aws-access-key-id and --aws-secret-access-key must be provided together')
  }

  if (mode === 'assets' && !abVersion) {
    throw new Error('Missing --ab-version (required for assets mode)')
  }
  if (mode === 'manifests' && !entityIdsArg && !entityIdsFile) {
    throw new Error('Missing --entity-ids or --entity-ids-file (required for manifests mode)')
  }

  const config = await createDotEnvConfigComponent({ path: ['.env.default', '.env'] })
  const awsRegion = args['--aws-region'] ?? (await config.getString('AWS_REGION'))
  if (awsRegion) AWS.config.update({ region: awsRegion })
  const bucket = args['--bucket'] ?? (await config.getString('CDN_BUCKET'))
  if (!bucket) throw new Error('CDN_BUCKET is not set (pass --bucket or set the env var)')

  const s3Config: AWS.S3.ClientConfiguration = {}
  if (cliAccessKeyId && cliSecretAccessKey) {
    // Static creds from CLI flags. Do not log these — they're already at risk
    // of leaking via `ps` and shell history; don't add a third leak channel.
    s3Config.credentials = new AWS.Credentials({
      accessKeyId: cliAccessKeyId,
      secretAccessKey: cliSecretAccessKey,
      sessionToken: cliSessionToken
    })
  }
  const s3 = new AWS.S3(s3Config)

  const credSource = cliAccessKeyId ? 'cli-flags' : 'sdk-default-chain'
  const startedAt = Date.now()

  if (mode === 'assets') {
    console.log(
      `Starting deletion (assets): bucket=${bucket} abVersion=${abVersion} target=${target ?? '(all)'} execute=${execute} credentials=${credSource}`
    )
    if (!execute) console.log('DRY RUN — no objects will be deleted. Pass --execute to perform deletes.')

    const stats = await runDeletion({
      s3,
      bucket,
      abVersion: abVersion!,
      target,
      execute,
      log: (msg) => console.warn(msg),
      onProgress: (snapshot) => {
        const elapsedSec = ((Date.now() - startedAt) / 1000).toFixed(1)
        console.log(`[${elapsedSec}s] progress: ${JSON.stringify(snapshot)}`)
      }
    })

    const elapsedSec = ((Date.now() - startedAt) / 1000).toFixed(1)
    console.log(`\nDeletion ${execute ? '' : '(DRY RUN) '}complete in ${elapsedSec}s`)
    console.log(JSON.stringify(stats, null, 2))
    return
  }

  // manifests mode
  const inlineIds = entityIdsArg ? entityIdsArg.split(',') : []
  const fileIds = entityIdsFile ? parseEntityIdsFile(await fs.readFile(entityIdsFile, 'utf8')) : []
  const entityIds = [...inlineIds, ...fileIds]
  if (entityIds.filter((id) => id.trim().length > 0).length === 0) {
    throw new Error('No entity IDs supplied (input was empty after parsing)')
  }

  console.log(
    `Starting deletion (manifests): bucket=${bucket} entityIds=${entityIds.length} target=${target ?? '(all)'} execute=${execute} credentials=${credSource}`
  )
  if (!execute) console.log('DRY RUN — no objects will be deleted. Pass --execute to perform deletes.')

  const stats = await runManifestDeletion({
    s3,
    bucket,
    entityIds,
    target,
    execute,
    log: (msg) => console.warn(msg)
  })

  const elapsedSec = ((Date.now() - startedAt) / 1000).toFixed(1)
  console.log(`\nManifest deletion ${execute ? '' : '(DRY RUN) '}complete in ${elapsedSec}s`)
  console.log(JSON.stringify(stats, null, 2))
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err)
    process.exit(1)
  })
}
