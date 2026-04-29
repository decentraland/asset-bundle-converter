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
import {
  canonicalFilenameForAsset,
  computePerAssetDigests,
  fileExtension,
  GltfFetcher,
  mapBounded
} from './logic/asset-reuse'
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
  /** Manifests whose entity metadata was readable but whose per-glb digest
   * computation failed (malformed glb, catalyst 404 on a glb byte fetch,
   * etc.). Distinct from `manifestsEntityFetchFailed` because the catalyst
   * responded at the `/entities/active` level — it's the glb asset fetch
   * underneath that failed, and an operator diagnosing the two cases needs
   * different remediation (reachability vs. content validity). */
  manifestsDigestFailed: number
  bundlesProbed: number
  bundlesAlreadyCanonical: number
  bundlesCopied: number
  glbRenamedCount: number
  bundlesMissingSource: number
  /** Glb bundle entries listed in a kept manifest whose hash was marked
   * skipped by the digest computation (missing deps / unparseable bytes).
   * The live converter would never produce a canonical bundle for them, so
   * we don't migrate them either — copying the pre-PR entity-scoped bundle
   * to a canonical key nothing probes would just create dead storage.
   * Distinct from `manifestsDigestFailed`: that one is "the whole digest
   * step threw"; this one is "the step succeeded but the manifest carries
   * bundles the live converter no longer emits." */
  glbSkippedDuringMigration: number
  errors: number
}

function emptyStats(): MigrationStats {
  return {
    manifestsScanned: 0,
    manifestsKept: 0,
    manifestsSkipped: 0,
    manifestsMissingContentServer: 0,
    manifestsEntityFetchFailed: 0,
    manifestsDigestFailed: 0,
    bundlesProbed: 0,
    bundlesAlreadyCanonical: 0,
    bundlesCopied: 0,
    glbRenamedCount: 0,
    bundlesMissingSource: 0,
    glbSkippedDuringMigration: 0,
    errors: 0
  }
}

/**
 * Split a pre-PR bundle filename into `{hash, variant}` for a given target.
 * Pre-PR filenames are `{hash}_{target}(\.br|\.manifest|\.manifest\.br)?` where
 * `{hash}` has no `_` — tightening the capture to `[^_]+` excludes any
 * already-composite filename that somehow leaks in (those aren't migrateable
 * because their canonical copies come from the new converter, not this script).
 *
 * Exported for unit testing: the migration's canonical-key derivation composes
 * this parser with `canonicalFilenameForAsset` + `computePerAssetDigests`, and
 * tests pin that composition against the live converter's key builder.
 */
export function splitBundleName(filename: string, target: string): { hash: string; variant: string } | null {
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
   * don't depend on network fetches. Must return the entity's `.content` array. */
  fetchEntity?: (entityId: string, contentServerUrl: string) => Promise<{ content: { file: string; hash: string }[] }>
  /** GLB/GLTF byte fetcher used by `computePerAssetDigests`. Forwarded to the
   * digest-computation helper so tests can stub glb downloads without hitting
   * a real catalyst. Defaults to the production fetcher that talks to the
   * catalyst directly (retries + Content-Length guards + streaming). */
  gltfFetcher?: GltfFetcher
  /** Fallback catalyst URL used when a manifest body doesn't carry its own
   * `contentServerUrl`. Pre-PR manifests were written before we started
   * stamping that field, so for a backfill run the operator should pass
   * `--content-server-url https://peer.decentraland.org/content` — otherwise
   * every pre-PR manifest is skipped. Manifest-embedded value wins if both
   * are present (the manifest was produced against a specific catalyst). */
  contentServerUrl?: string
  /** Per-catalyst-call timeout. Without this a hung or unresponsive catalyst
   * would stall the whole migration loop (sequential by manifest). Default
   * 30s via main(); tests can override to keep suites fast. Only applied to
   * the default fetcher — custom stubs can impose their own timing. */
  catalystTimeoutMs?: number
}

const DEFAULT_CATALYST_TIMEOUT_MS = 30_000

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
  // Clamp against 0 / negative so `--catalyst-timeout-ms 0` can't silently
  // abort every fetch on the next tick (AbortController + setTimeout(…, 0)
  // would otherwise fire before the fetch finishes). A 1s floor is still
  // effectively "fail fast" for tests that genuinely want a short timeout,
  // but it removes the footgun where an operator meant "no timeout" and got
  // "instant abort" instead.
  const MIN_CATALYST_TIMEOUT_MS = 1000
  const rawTimeout = opts.catalystTimeoutMs ?? DEFAULT_CATALYST_TIMEOUT_MS
  const catalystTimeoutMs = Math.max(MIN_CATALYST_TIMEOUT_MS, rawTimeout)
  // Surface the clamp so an operator who supplied a too-low value (or 0)
  // doesn't spend time wondering why the effective timeout is larger than
  // what they passed. Only fires when the clamp actually kicked in.
  if (rawTimeout < MIN_CATALYST_TIMEOUT_MS) {
    log(
      `[catalyst-timeout] requested ${rawTimeout}ms is below the ${MIN_CATALYST_TIMEOUT_MS}ms floor; using ${catalystTimeoutMs}ms to avoid racing against fetch startup`
    )
  }
  // Default fetcher wraps `getActiveEntity` with a hard timeout so a hung
  // catalyst can't stall the migration. Custom stubs (tests) keep their own
  // timing.
  const fetchEntity = opts.fetchEntity ?? ((id: string, url: string) => getActiveEntity(id, url, catalystTimeoutMs))
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
    let entityContent: { file: string; hash: string }[]
    try {
      // `getActiveEntity` throws on non-200 responses. The `!entity` guard
      // below is defense-in-depth in case the response parses to null/empty.
      const entity = await fetchEntity(parsed.entityId, catalystUrl)
      if (!entity || !Array.isArray(entity.content)) {
        throw new Error('entity no longer active on catalyst (redeployed or evicted)')
      }
      entityContent = entity.content
      extByHash = new Map<string, string>()
      for (const c of entityContent) extByHash.set(c.hash, fileExtension(c.file))
    } catch (err: any) {
      log(`[${obj.Key}] failed to fetch entity: ${err.message}`)
      stats.manifestsEntityFetchFailed++
      continue
    }

    // Per-glb digests match what the live converter uploads today. The pre-PR
    // entity-wide digest produced a single digest for all glbs in an entity;
    // the live converter now emits per-glb digests derived from each glb's
    // actual URI references. Copying bundles under the old entity-wide scheme
    // here would land them at paths nothing probes — dead storage forever.
    //
    // Computing the digest requires downloading each glb's bytes from the
    // catalyst to parse its external-URI list. That's heavier than the
    // pre-port path (one-shot hash of entity.content) but matches the live
    // converter byte-for-byte, which is the invariant we care about.
    let depsDigestByHash: ReadonlyMap<string, string>
    let skippedHashes: ReadonlySet<string>
    try {
      const digestResult = await computePerAssetDigests({ content: entityContent }, catalystUrl, {
        fetcher: opts.gltfFetcher
      })
      depsDigestByHash = digestResult.digests
      skippedHashes = new Set(digestResult.skipped.keys())
    } catch (err: any) {
      // Catalyst returned 404 on a glb byte fetch, network failure, etc.
      // Content-deterministic defects (missing deps / unparseable bytes)
      // land in `digestResult.skipped` instead of throwing — those are
      // counted per-bundle below as `glbSkippedDuringMigration`. Only true
      // fetch/infra failures reach this branch.
      log(`[${obj.Key}] failed to compute per-glb digests: ${err.message}`)
      stats.manifestsDigestFailed++
      continue
    }

    stats.manifestsKept++

    const sourcePrefix = `${abVersion}/${parsed.entityId}`
    const candidates = manifest.files.filter((f) => bundlePattern.test(f))

    await mapBounded(candidates, concurrency, async (filename) => {
      // Single split serves both the skip-filter below and the canonical-
      // name derivation further down. Splitting twice was harmless but the
      // regex match isn't free on long candidate lists.
      const parts = splitBundleName(filename, target)

      // Bundles whose content hash the live converter would never produce
      // (missing deps / unparseable glb) have no canonical destination —
      // skip without probe so we don't even count the work. The pre-PR
      // entity-scoped bundle stays where it is; once entity-scoped storage
      // is purged in a follow-up, those orphan keys disappear naturally.
      if (parts && skippedHashes.has(parts.hash)) {
        stats.glbSkippedDuringMigration++
        return
      }

      stats.bundlesProbed++

      // Source file on pre-PR entity-scoped layout retains the bare filename
      // Unity originally produced — we only rename on the canonical destination.
      const sourceKey = `${sourcePrefix}/${filename}`

      const ext = parts ? (extByHash.get(parts.hash) ?? '') : ''
      // `canonicalFilenameForAsset` throws when asked for a glb/gltf hash that
      // is missing from the digest map — that shouldn't happen here because
      // `computePerAssetDigests` keys every gltf-extension content entry, but
      // if an entity was redeployed mid-migration and its glb now points at a
      // bundle filename that's not in the recomputed digest set, we'd rather
      // skip that one candidate than abort the whole manifest. Bare-hash
      // fallback for non-gltf extensions is handled by the callee internally.
      let destFilename: string
      try {
        destFilename = parts
          ? `${canonicalFilenameForAsset(parts.hash, ext, target, depsDigestByHash)}${parts.variant}`
          : filename
      } catch (err: any) {
        log(`[${obj.Key}/${filename}] canonical-name derivation failed: ${err.message}`)
        stats.errors++
        return
      }
      const canonicalKey = `${canonicalPrefix}/${destFilename}`
      // Held locally and only reflected into stats when the copy actually
      // happens (or would happen in dry-run), so the counter tracks real work
      // done rather than intent. If the HEAD fails transiently or the source
      // has disappeared, the counter stays untouched for that bundle.
      const isRename = destFilename !== filename

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
        if (isRename) stats.glbRenamedCount++
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
        if (isRename) stats.glbRenamedCount++
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
    '--catalyst-timeout-ms': Number,
    '--dry-run': Boolean,
    '--concurrency': Number,
    '--help': Boolean
  })

  if (args['--help']) {
    console.log(`
Usage: yarn migrate --ab-version <v> --target <webgl|windows|mac> [options]

Copy existing {AB_VERSION}/{entityId}/{hash}_{target}* bundles into the
canonical {AB_VERSION}/assets/ layout. glb/gltf bundles land at
{hash}_{perGlbDepsDigest}_{target}; bins and textures at {hash}_{target}.

Per-glb digests match what the live converter uploads today — the script
downloads each glb's bytes from the catalyst to extract its external-URI
references and compute the same digest the converter would. That's heavier
than the original entity-wide-digest backfill, but it's the only scheme
that produces canonical paths which live converter probes will hit.

Safe to re-run: every candidate is HEAD-probed before copy; already-canonical
destinations are no-ops. Same-bucket CopyObject is server-side, no egress
through this process.

Options:
  --ab-version <v>            AB_VERSION prefix (e.g. v48). Required.
  --target <t>                Build target (webgl|windows|mac). Required.
  --content-server-url <url>  Fallback catalyst URL used when a manifest's body
                              is missing contentServerUrl. Required for backfill
                              of pre-PR-#258 manifests (they predate that
                              field). Typically https://peer.decentraland.org/content.
  --catalyst-timeout-ms <n>   Per-entity catalyst fetch timeout in ms (default 30000).
                              Prevents a hung catalyst from stalling the run.
  --dry-run                   Log intended copies, do not mutate the bucket.
  --concurrency <n>           Parallel probe+copy workers per manifest (default 50).
`)
    return
  }

  const abVersion = args['--ab-version']
  const target = args['--target']
  const contentServerUrl = args['--content-server-url']
  const catalystTimeoutMs = args['--catalyst-timeout-ms']
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
    catalystTimeoutMs,
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
