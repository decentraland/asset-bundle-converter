import { Entity } from '@dcl/schemas'
import { AppComponents } from '../../types'
import { getUnityBuildTarget, normalizeContentsBaseUrl } from '../../utils'
import {
  AssetCacheResult,
  PerAssetDigestResult,
  SkippedAsset,
  checkAssetCache as checkAssetCacheImpl,
  computePerAssetDigests as computePerAssetDigestsImpl,
  purgeCachedBundlesFromOutput as purgeCachedBundlesFromOutputImpl
} from '../asset-reuse'
import { IScenesComponent, Manifest, ProbeArgs, ProbeOutcome, UploadFastPathArgs } from './types'

// Internal-only arg/option shapes for the two closures the component uses but
// doesn't expose publicly (probe() consumes both). Kept here rather than in
// `types.ts` because they're not part of the IScenesComponent surface.
type CheckAssetCacheArgs = {
  entity: Entity
  abVersion: string
  buildTarget: string
  cdnBucket: string
  depsDigestByHash?: ReadonlyMap<string, string>
}

type ComputePerAssetDigestsOptions = {
  aggregateTimeoutMs?: number
  fetcher?: (url: string, ext: '.glb' | '.gltf') => Promise<Buffer>
  /** Label values forwarded to the glb-deps cache outcome counter. When
   * absent the metric isn't emitted, but the cache still works. */
  metricLabels?: { build_target: string; ab_version: string }
}

// Upper bound on a single `/entities/active` catalyst call before we fall back
// to "couldn't fetch entity, upload to entity-scoped path without source files".
// Historically unset, which meant a wedged catalyst would pin the worker slot
// until SQS visibility (1-2 min) retried the whole job — by which point the
// replacement worker would hit the same wedge. Bounding at 30s lets us degrade
// gracefully within a single visibility window: the probe path can't run, but
// the conversion still proceeds against raw hashes, and Unity still produces
// usable bundles. Matches the default the migration script uses.
const CATALYST_FETCH_TIMEOUT_MS = 30_000

// Aggregate cap on `computePerAssetDigests` for one probe. Each catalyst fetch
// inside is already bounded (3 retry attempts × ≤30s Retry-After clamp), but a
// scene with dozens of glbs each backing off to the cap could compound past
// SQS's visibility window. Past this point we treat the digest pass as a scene
// conversion failure: upload the failed-manifest sentinel and let SQS retry.
const PROBE_DIGEST_TIMEOUT_MS = 60_000

/**
 * Normalise a thrown value (which TypeScript types as `unknown`) into an
 * `Error` instance, so callers can rely on `.message` / `.stack` without
 * defensively branching at every site. The fallback `new Error(String(e))`
 * covers `throw 'string'` / `throw { …non-Error… }` and similar.
 */
function toError(e: unknown): Error {
  return e instanceof Error ? e : new Error(String(e))
}

/**
 * Build the centralised scene-pipeline component. Captures dependencies once
 * and exposes the full pre-Unity surface (probe, asset-cache lookup, per-glb
 * digest, post-Unity cleanup, fast-path upload, manifest publish, source-file
 * publish) as one importable thing.
 *
 * The probe + fast-path-upload bodies live inline here; the heavier S3 / GLB
 * operations delegate to free-function implementations in `logic/asset-reuse.ts`
 * to keep this component's surface explicit while the underlying machinery
 * stays unit-tested in place.
 */
export async function createScenesComponent(
  components: Pick<AppComponents, 'logs' | 'config' | 'metrics' | 'cdnS3' | 'sentry' | 'catalyst' | 'redis'>
): Promise<IScenesComponent> {
  // `metrics` isn't destructured here because this component's own methods
  // don't emit metrics directly — but it's required in the Pick<> because the
  // delegated impls (`checkAssetCacheImpl` and friends) read it from the
  // captured `components` reference passed through below. `redis` IS
  // destructured because `computePerAssetDigests` plumbs it through as an
  // explicit option to the underlying free function (alongside logger +
  // metrics) for the new glb URI cache.
  const { logs, config, cdnS3, sentry, catalyst, redis } = components
  const digestCacheLogger = logs.getLogger('glb-deps-cache')

  // CDN_BUCKET is a process-lifetime env var — resolve it once at construction
  // so `probe()` and downstream callers don't pay a config lookup per call.
  // Same `|| 'CDN_BUCKET'` placeholder semantics as the pre-refactor free
  // function: a missing env var falls back to the literal so local dev / tests
  // that don't set CDN_BUCKET still get a deterministic string.
  const cachedCdnBucket = (await config.getString('CDN_BUCKET')) || 'CDN_BUCKET'

  // Shared TTL applied to BOTH Redis caches the probe path uses:
  //   - the probe hit-cache (canonical S3 existence markers)
  //   - the glb URI cache (parsed dep refs for digest computation)
  // Process-lifetime; resolve once and forward into every call. Unset (or
  // unparseable) keeps the implementation default — both cached values are
  // content-deterministic so a stale entry is harmless, the TTL only governs
  // how long the keyspace holds dead entries.
  const redisTtlSecondsRaw = await config.getNumber('REDIS_CACHE_TTL_SECONDS')
  const cachedRedisTtlSeconds =
    redisTtlSecondsRaw !== undefined && redisTtlSecondsRaw > 0 ? redisTtlSecondsRaw : undefined

  // The async signature is preserved for interface flexibility (callers `await`
  // this without caring whether the impl is sync or async, and a future variant
  // that re-reads from a mutable config source would slot in here transparently).
  // Today the call resolves to a captured string with no I/O.
  async function getCdnBucket(): Promise<string> {
    return cachedCdnBucket
  }

  function manifestKeyForEntity(entityId: string, target: string | undefined): string {
    if (target) {
      return `manifest/${entityId}_${target}.json`
    } else {
      return `manifest/${entityId}.json`
    }
  }

  /**
   * Publish the top-level entity manifest (`manifest/{entityId}[_{target}].json`).
   *
   * Centralised because the `Cache-Control: private, max-age=0, no-cache` header
   * is safety-critical: if it's ever accidentally rewritten to immutable / long
   * max-age, clients will never pick up newly-converted scene hashes. Touching
   * this in exactly one place prevents drift between the short-circuit path and
   * the main path.
   */
  async function uploadEntityManifest(cdnBucket: string, key: string, manifest: Manifest): Promise<void> {
    await cdnS3
      .upload({
        Bucket: cdnBucket,
        Key: key,
        ContentType: 'application/json',
        Body: JSON.stringify(manifest),
        CacheControl: 'private, max-age=0, no-cache',
        ACL: 'public-read'
      })
      .promise()
  }

  /**
   * Downloads `main.crdt`, `scene.json`, and the entity's declared main script
   * from the catalyst and uploads them to the CDN bucket so the Explorer
   * desktop client can fetch them from S3 instead of the catalyst (which
   * occasionally drops files).
   *
   * Runs for any target on a successful conversion or fast-path hit; the
   * upload is cheap enough that we don't gate on build target.
   */
  async function uploadSceneSourceFilesToCDN(
    entity: Entity,
    contentServerUrl: string,
    uploadPath: string,
    cdnBucket: string
  ): Promise<void> {
    const logger = logs.getLogger('upload-scene-source-files')

    const filesToUpload: string[] = ['main.crdt', 'scene.json']
    const mainScript = typeof entity?.metadata?.main === 'string' ? entity.metadata.main : undefined
    if (mainScript) {
      filesToUpload.push(mainScript)
    }

    const contentsBaseUrl = normalizeContentsBaseUrl(contentServerUrl)

    // Fetch+upload all source files in parallel. Independent files, each a
    // catalyst round-trip + S3 PUT; serializing them was tens-of-ms × N files
    // of tail latency. Unbounded Promise.all is safe here because
    // `filesToUpload` is capped at 3 (main.crdt + scene.json + optional
    // `entity.metadata.main`).
    await Promise.all(
      filesToUpload.map(async (fileName) => {
        const contentDef = entity?.content?.find((c) => c.file === fileName)
        if (!contentDef) {
          logger.info(`${fileName} not found in entity content, skipping CDN upload`)
          return
        }

        const s3Key = `${uploadPath}/${fileName}`

        try {
          const fileUrl = `${contentsBaseUrl}${contentDef.hash}`
          const response = await globalThis.fetch(fileUrl)

          if (!response.ok) {
            await response.body?.cancel().catch(() => undefined)
            logger.error(
              `Failed to download ${fileName} from catalyst (${fileUrl}): ${response.status} ${response.statusText}`
            )
            return
          }

          const content = Buffer.from(await response.arrayBuffer())
          const contentType = fileName.endsWith('.js')
            ? 'application/javascript'
            : fileName.endsWith('.json')
              ? 'application/json'
              : 'application/octet-stream'

          await cdnS3
            .upload({
              Bucket: cdnBucket,
              Key: s3Key,
              Body: content,
              ContentType: contentType,
              ACL: 'public-read',
              CacheControl: 'public, max-age=31536000, immutable'
            })
            .promise()

          logger.info(`Uploaded ${fileName} to CDN at ${s3Key} (${content.length} bytes)`)
        } catch (err: any) {
          logger.error(`Failed to upload ${fileName} to CDN: ${err.message}`)
        }
      })
    )
  }

  // returns true if the asset was converted and uploaded with the same version of the converter
  async function shouldIgnoreConversion(
    $AB_VERSION: string,
    entityId: string,
    target: string | undefined
  ): Promise<boolean> {
    const cdnBucket = await getCdnBucket()
    const manifestFile = manifestKeyForEntity(entityId, target)

    try {
      const obj = await cdnS3.getObject({ Bucket: cdnBucket, Key: manifestFile }).promise()
      if (!obj.Body) return false
      const json: Manifest = JSON.parse(obj.Body?.toString())

      // not ignored when previous run had exit code
      if (json.exitCode) return false

      // ignored only when previous version is the same as current version
      if (json.version === $AB_VERSION) return true
    } catch {}

    return false
  }

  async function checkAssetCache(args: CheckAssetCacheArgs): Promise<AssetCacheResult> {
    return checkAssetCacheImpl(components, { ...args, redisTtlSeconds: cachedRedisTtlSeconds })
  }

  async function computePerAssetDigests(
    entity: Entity,
    contentServerUrl: string,
    options?: ComputePerAssetDigestsOptions
  ): Promise<PerAssetDigestResult> {
    return computePerAssetDigestsImpl(entity, contentServerUrl, {
      ...options,
      redis,
      redisTtlSeconds: cachedRedisTtlSeconds,
      logger: digestCacheLogger,
      metrics: components.metrics,
      metricLabels: options?.metricLabels
    })
  }

  async function purgeCachedBundlesFromOutput(outDirectory: string, cachedHashes: string[]): Promise<number> {
    return purgeCachedBundlesFromOutputImpl(outDirectory, cachedHashes, logs.getLogger('purge-bundles'))
  }

  /**
   * Pre-flight probe shared by the triage and conversion loops. Performs (in
   * order): build-target validation → already-converted short-circuit (gated on
   * `!force`) → catalyst entity fetch → asset-reuse eligibility check →
   * per-asset digest pass → cache probe → full/partial-hit determination. Each
   * branch point produces a {@link ProbeOutcome} variant; the caller maps it to
   * its own return semantics.
   *
   * `force=true` keeps the digest pass (canonical-path uploads need it) but
   * skips the cache probe so the caller's "redo this scene from scratch"
   * intent isn't silently ignored by a hit. The asset-reuse gate is computed
   * from `assetReuseEnabled && !doISS && entity.type === 'scene'` so callers
   * can't forget the doISS exclusion.
   *
   * The probe owns the failed-manifest sentinel upload on digest failure so
   * both callers surface the same client-visible signal without duplicating
   * the upload block.
   */
  async function probe(args: ProbeArgs): Promise<ProbeOutcome> {
    const { entityId, contentServerUrl, abVersion, buildTarget, force, assetReuseEnabled, doISS } = args
    const logger = logs.getLogger('probe-scene')
    const sentryPhase = args.sentryPhase ?? 'per-asset-digest'

    const unityBuildTarget = getUnityBuildTarget(buildTarget)
    if (!unityBuildTarget) {
      logger.info('Invalid build target ' + buildTarget)
      return { kind: 'invalid-build-target' }
    }

    if (!force && (await shouldIgnoreConversion(abVersion, entityId, buildTarget))) {
      logger.info('Ignoring conversion (already converted)', { entityId, contentServerUrl, abVersion })
      return { kind: 'already-converted' }
    }

    const cdnBucket = await getCdnBucket()
    const failedManifestFile = `manifest/${entityId}_failed.json`

    let entity: Entity
    let entityType: string
    try {
      const fetched = await catalyst.getActiveEntity(entityId, contentServerUrl, CATALYST_FETCH_TIMEOUT_MS)
      if (!fetched) throw new Error('entity no longer active on catalyst (redeployed or evicted)')
      entity = fetched
      entityType = entity.type
    } catch (e: any) {
      logger.info(`Could not fetch entity for ${entityId}: ${e?.message ?? e}`)
      return { kind: 'catalyst-unreachable', error: toError(e) }
    }

    const useAssetReuse = assetReuseEnabled && !doISS && entityType === 'scene'
    if (!useAssetReuse) {
      return { kind: 'no-asset-reuse', entity, entityType }
    }

    let depsDigestByHash: ReadonlyMap<string, string>
    let skippedAssets: ReadonlyMap<string, SkippedAsset>
    try {
      const digestResult = await computePerAssetDigests(entity, contentServerUrl, {
        aggregateTimeoutMs: PROBE_DIGEST_TIMEOUT_MS,
        metricLabels: { build_target: buildTarget, ab_version: abVersion }
      })
      depsDigestByHash = digestResult.digests
      skippedAssets = digestResult.skipped
    } catch (err: any) {
      logger.error(`Per-asset digest computation failed: ${err?.message ?? err}`, { entityId, contentServerUrl })
      // captureException (vs captureMessage) so Sentry gets the full error
      // object including stack — the failed-manifest body carries the same
      // message for clients, but Sentry triage needs the stack to find where
      // the throw originated (glb parse? URI escape? catalyst 404?).
      sentry.captureException(err, {
        level: 'error',
        tags: {
          entityId,
          contentServerUrl,
          unityBuildTarget,
          version: abVersion,
          phase: sentryPhase
        }
      })
      try {
        await cdnS3
          .upload({
            Bucket: cdnBucket,
            Key: failedManifestFile,
            ContentType: 'application/json',
            Body: JSON.stringify({
              entityId,
              contentServerUrl,
              version: abVersion,
              error: err?.message ?? String(err),
              date: new Date().toISOString()
            }),
            CacheControl: 'max-age=3600,s-maxage=3600',
            ACL: 'public-read'
          })
          .promise()
      } catch (uploadErr: any) {
        // If the sentinel upload ALSO fails, we lose the one signal clients
        // have that this scene won't convert. Surface at warn level so ops sees
        // a cascading failure instead of silence.
        logger.warn(
          `Failed to upload failed-manifest sentinel after digest failure: ${uploadErr?.message ?? uploadErr}`
        )
      }
      return { kind: 'digest-failed', error: toError(err) }
    }

    if (force) {
      // Honour the operator's "redo this entity from scratch" intent: digests
      // are still needed for canonical upload paths, but the cache probe is
      // skipped so cached short-circuits can't mask the force.
      return { kind: 'cache-probe-skipped', entity, depsDigestByHash, skippedAssets }
    }

    let cacheResult: AssetCacheResult
    try {
      cacheResult = await checkAssetCache({
        entity,
        abVersion,
        buildTarget,
        cdnBucket,
        depsDigestByHash
      })
    } catch (e: any) {
      logger.warn(`Asset cache probe failed: ${e?.message ?? e}`)
      return {
        kind: 'cache-probe-failed',
        entity,
        depsDigestByHash,
        skippedAssets,
        error: toError(e)
      }
    }

    const totalProbed = cacheResult.cachedHashes.length + cacheResult.missingHashes.length
    const fullCacheHit = totalProbed > 0 && cacheResult.missingHashes.length === 0
    if (fullCacheHit) {
      return { kind: 'full-hit', entity, cacheResult, depsDigestByHash, skippedAssets }
    }
    return { kind: 'partial-hit', entity, cacheResult, depsDigestByHash, skippedAssets }
  }

  /**
   * Publishes the entity manifest and (for scenes) the scene source files for a
   * `full-hit` probe outcome. Centralised so both callers (triage fast-path and
   * conversion fast-path) emit byte-identical client-visible output for the
   * same scene state.
   *
   * Throws on any upload failure. Triage catches and republishes (transient
   * upload errors are usually recoverable on retry). The conversion loop
   * catches, Sentry-captures, and rethrows so the surrounding error handler
   * can fire.
   */
  async function uploadFastPathResult(args: UploadFastPathArgs): Promise<void> {
    const { entity, contentServerUrl, cdnBucket, manifestFile, entityScopedUploadPath, abVersion, cacheResult } = args
    const files = cacheResult.cachedHashes.map((h) => cacheResult.canonicalNameByHash[h])
    const manifest: Manifest = {
      version: abVersion,
      files,
      exitCode: 0,
      contentServerUrl,
      date: new Date().toISOString()
    }
    // Scene source files first, then manifest — so a client that sees a freshly
    // published manifest never races against a missing main.crdt / scene.json /
    // index.js. Symmetric with executeConversion's Unity-path: the
    // `entity.type === 'scene'` guard is defense-in-depth, since the only
    // caller today (the full-hit branch in conversion-task.ts) reaches us via
    // the probe's scene-only gate. Skipping source files for a non-scene
    // wouldn't corrupt anything (the catalyst content map wouldn't carry the
    // scene files anyway), but the guard makes the contract explicit if a
    // future caller invokes uploadFastPathResult outside the full-hit path.
    if (entity.type === 'scene') {
      await uploadSceneSourceFilesToCDN(entity, contentServerUrl, entityScopedUploadPath, cdnBucket)
    }
    await uploadEntityManifest(cdnBucket, manifestFile, manifest)
  }

  return {
    probe,
    uploadFastPathResult,
    purgeCachedBundlesFromOutput,
    getCdnBucket,
    manifestKeyForEntity,
    uploadEntityManifest,
    uploadSceneSourceFilesToCDN
  }
}
