import { Entity } from '@dcl/schemas'
import { AppComponents } from '../types'
import { getUnityBuildTarget, normalizeContentsBaseUrl } from '../utils'
import { AssetCacheResult, SkippedAsset, checkAssetCache, computePerAssetDigests } from './asset-reuse'

export type Manifest = {
  version: string
  files: string[]
  exitCode: number | null
  contentServerUrl?: string
  date: string
}

// Upper bound on a single `/entities/active` catalyst call before we fall back
// to "couldn't fetch entity, upload to entity-scoped path without source files".
// Historically unset, which meant a wedged catalyst would pin the worker slot
// until SQS visibility (1-2 min) retried the whole job — by which point the
// replacement worker would hit the same wedge. Bounding at 30s lets us degrade
// gracefully within a single visibility window: the probe path can't run, but
// the conversion still proceeds against raw hashes, and Unity still produces
// usable bundles. Matches the default the migration script uses.
export const CATALYST_FETCH_TIMEOUT_MS = 30_000

export async function getCdnBucket(components: Pick<AppComponents, 'config'>): Promise<string> {
  return (await components.config.getString('CDN_BUCKET')) || 'CDN_BUCKET'
}

export function manifestKeyForEntity(entityId: string, target: string | undefined): string {
  if (target && target !== 'webgl') {
    return `manifest/${entityId}_${target}.json`
  } else {
    return `manifest/${entityId}.json`
  }
}

/**
 * Publish the top-level entity manifest (`manifest/{entityId}[_{target}].json`).
 *
 * Centralized because the `Cache-Control: private, max-age=0, no-cache` header
 * is safety-critical: if it's ever accidentally rewritten to immutable / long
 * max-age, clients will never pick up newly-converted scene hashes. Touching
 * this in exactly one place prevents drift between the short-circuit path and
 * the main path.
 */
export async function uploadEntityManifest(
  components: Pick<AppComponents, 'cdnS3'>,
  cdnBucket: string,
  key: string,
  manifest: Manifest
): Promise<void> {
  await components.cdnS3
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
 * Downloads index.js (main scene script) and main.crdt from the catalyst and
 * uploads them to the CDN bucket. This allows the Explorer desktop client to
 * fetch these critical scene files from S3 instead of the catalyst, avoiding a
 * class of failures where files are missing from the catalyst.
 *
 * Only runs for non-webgl targets (Mac/Windows desktop builds) since those
 * clients use this CDN path.
 */
export async function uploadSceneSourceFilesToCDN(
  components: Pick<AppComponents, 'logs' | 'cdnS3'>,
  entity: Entity,
  contentServerUrl: string,
  uploadPath: string,
  cdnBucket: string
): Promise<void> {
  const logger = components.logs.getLogger('UploadSceneSourceFiles')

  // Collect the filenames to upload: main.crdt, scene.json, and the main scene script (usually index.js)
  const filesToUpload: string[] = ['main.crdt', 'scene.json']
  const mainScript = typeof entity?.metadata?.main === 'string' ? entity.metadata.main : undefined
  if (mainScript) {
    filesToUpload.push(mainScript)
  }

  const contentsBaseUrl = normalizeContentsBaseUrl(contentServerUrl)

  // Fetch+upload all source files in parallel. Independent files, each a catalyst
  // round-trip + S3 PUT; serializing them was tens-of-ms × N files of tail latency.
  // Unbounded Promise.all is safe here because `filesToUpload` is capped at 3
  // (main.crdt + scene.json + optional `entity.metadata.main`).
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

        await components.cdnS3
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
export async function shouldIgnoreConversion(
  components: Pick<AppComponents, 'logs' | 'metrics' | 'config' | 'cdnS3'>,
  $AB_VERSION: string,
  entityId: string,
  target: string | undefined
): Promise<boolean> {
  const cdnBucket = await getCdnBucket(components)
  const manifestFile = manifestKeyForEntity(entityId, target)

  try {
    const obj = await components.cdnS3.getObject({ Bucket: cdnBucket, Key: manifestFile }).promise()
    if (!obj.Body) return false
    const json: Manifest = JSON.parse(obj.Body?.toString())

    // not ignored when previous run had exit code
    if (json.exitCode) return false

    // ignored only when previous version is the same as current version
    if (json.version === $AB_VERSION) return true
  } catch {}

  return false
}

/**
 * Structured outcome of a scene-conversion probe. Each variant corresponds to a
 * branch point that previously lived in both `executeTriagePass` and
 * `executeConversion`; this discriminated union lets each caller map the
 * outcome to its own return shape (triage's `TriagePassOutcome` vs. conversion's
 * numeric exit code) without duplicating the probe logic.
 *
 * - `invalid-build-target`: `BUILD_TARGET` is not webgl/windows/mac.
 * - `already-converted`: `shouldIgnoreConversion` short-circuited — a manifest
 *   already exists at the current AB version with exitCode 0. Caller returns 13.
 * - `catalyst-unreachable`: catalyst entity fetch failed (timeout, network,
 *   evicted-from-active). Triage republishes; conversion proceeds to Unity
 *   against raw hashes with no asset-reuse.
 * - `no-asset-reuse`: probe was skipped because the kill switch is off, the
 *   caller passed doISS, or the entity is not a scene (wearables/emotes always
 *   need Unity).
 * - `digest-failed`: `computePerAssetDigests` threw. Failed-manifest sentinel
 *   was uploaded by the probe; Sentry was notified. Caller returns
 *   `UNEXPECTED_ERROR` (exit code 5).
 * - `cache-probe-skipped`: caller passed `force=true`, so the cache probe was
 *   skipped to honour the "redo this unconditionally" semantics. Digests were
 *   still computed because the canonical-path upload needs them. Caller
 *   proceeds to Unity.
 * - `cache-probe-failed`: digest pass succeeded but `checkAssetCache` threw.
 *   Caller proceeds to Unity (digests are still usable for canonical paths).
 * - `partial-hit`: at least one asset hash was missing canonical bytes. Caller
 *   proceeds to Unity with `cachedHashes` so Unity skips converting those.
 * - `full-hit`: every probed hash is canonical. Caller uploads the entity
 *   manifest + source files via {@link uploadFastPathResult} and returns success.
 */
export type ProbeOutcome =
  | { kind: 'invalid-build-target' }
  | { kind: 'already-converted' }
  | { kind: 'catalyst-unreachable'; error: Error }
  | { kind: 'no-asset-reuse'; entity: Entity | null; entityType: string }
  | { kind: 'digest-failed'; error: Error }
  | {
      kind: 'cache-probe-skipped'
      entity: Entity
      entityType: string
      depsDigestByHash: ReadonlyMap<string, string>
      skippedAssets: ReadonlyMap<string, SkippedAsset>
    }
  | {
      kind: 'cache-probe-failed'
      entity: Entity
      entityType: string
      depsDigestByHash: ReadonlyMap<string, string>
      skippedAssets: ReadonlyMap<string, SkippedAsset>
      error: Error
    }
  | {
      kind: 'partial-hit'
      entity: Entity
      entityType: string
      cacheResult: AssetCacheResult
      depsDigestByHash: ReadonlyMap<string, string>
      skippedAssets: ReadonlyMap<string, SkippedAsset>
    }
  | {
      kind: 'full-hit'
      entity: Entity
      entityType: string
      cacheResult: AssetCacheResult
      depsDigestByHash: ReadonlyMap<string, string>
      skippedAssets: ReadonlyMap<string, SkippedAsset>
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
 * intent isn't silently ignored by a hit. `useAssetReuseGate` mirrors the
 * caller's `ASSET_REUSE_ENABLED && !doISS` decision — the probe additionally
 * requires `entity.type === 'scene'` and a successfully-fetched entity.
 *
 * The probe owns the failed-manifest sentinel upload on digest failure so
 * both callers surface the same client-visible signal without duplicating
 * the upload block.
 */
export async function probeScene(
  components: Pick<AppComponents, 'logs' | 'metrics' | 'config' | 'cdnS3' | 'sentry' | 'catalyst'>,
  args: {
    entityId: string
    contentServerUrl: string
    abVersion: string
    buildTarget: string
    force: boolean
    /** Caller's `ASSET_REUSE_ENABLED && !doISS` decision. The probe ANDs this with `entity.type === 'scene'`. */
    useAssetReuseGate: boolean
    /** Tag applied to the Sentry event on digest failure. Defaults to `per-asset-digest`. */
    sentryPhase?: string
  }
): Promise<ProbeOutcome> {
  const { entityId, contentServerUrl, abVersion, buildTarget, force, useAssetReuseGate } = args
  const logger = components.logs.getLogger('probe-scene')
  const sentryPhase = args.sentryPhase ?? 'per-asset-digest'

  const unityBuildTarget = getUnityBuildTarget(buildTarget)
  if (!unityBuildTarget) {
    logger.info('Invalid build target ' + buildTarget)
    return { kind: 'invalid-build-target' }
  }

  if (!force && (await shouldIgnoreConversion(components, abVersion, entityId, buildTarget))) {
    logger.info('Ignoring conversion (already converted)', { entityId, contentServerUrl, abVersion })
    return { kind: 'already-converted' }
  }

  const cdnBucket = await getCdnBucket(components)
  const failedManifestFile = `manifest/${entityId}_failed.json`

  let entity: Entity
  let entityType: string
  try {
    const fetched = await components.catalyst.getActiveEntity(entityId, contentServerUrl, CATALYST_FETCH_TIMEOUT_MS)
    if (!fetched) throw new Error('entity no longer active on catalyst (redeployed or evicted)')
    entity = fetched
    entityType = entity.type
  } catch (e: any) {
    logger.info(`Could not fetch entity for ${entityId}: ${e?.message ?? e}`)
    return { kind: 'catalyst-unreachable', error: e instanceof Error ? e : new Error(String(e)) }
  }

  if (!useAssetReuseGate || entityType !== 'scene') {
    return { kind: 'no-asset-reuse', entity, entityType }
  }

  let depsDigestByHash: ReadonlyMap<string, string>
  let skippedAssets: ReadonlyMap<string, SkippedAsset>
  try {
    // 60s aggregate cap on the digest pass. Each catalyst fetch is already
    // bounded (3 retry attempts × ≤30s Retry-After clamp), but a scene with
    // dozens of glbs each backing off to the cap could compound past SQS's
    // visibility window. Past this point we treat the digest pass as a scene
    // conversion failure: upload the failed-manifest sentinel and let SQS
    // retry.
    const digestResult = await computePerAssetDigests(entity, contentServerUrl, { aggregateTimeoutMs: 60_000 })
    depsDigestByHash = digestResult.digests
    skippedAssets = digestResult.skipped
  } catch (err: any) {
    logger.error(`Per-asset digest computation failed: ${err?.message ?? err}`, { entityId, contentServerUrl })
    // captureException (vs captureMessage) so Sentry gets the full error object
    // including stack — the failed-manifest body carries the same message for
    // clients, but Sentry triage needs the stack to find where the throw
    // originated (glb parse? URI escape? catalyst 404?).
    components.sentry.captureException(err, {
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
      await components.cdnS3
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
      // If the sentinel upload ALSO fails, we lose the one signal clients have
      // that this scene won't convert. Surface at warn level so ops sees a
      // cascading failure instead of silence.
      logger.warn(`Failed to upload failed-manifest sentinel after digest failure: ${uploadErr?.message ?? uploadErr}`)
    }
    return { kind: 'digest-failed', error: err instanceof Error ? err : new Error(String(err)) }
  }

  if (force) {
    // Honour the operator's "redo this entity from scratch" intent: digests
    // are still needed for canonical upload paths, but the cache probe is
    // skipped so cached short-circuits can't mask the force.
    return { kind: 'cache-probe-skipped', entity, entityType, depsDigestByHash, skippedAssets }
  }

  let cacheResult: AssetCacheResult
  try {
    cacheResult = await checkAssetCache(components, {
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
      entityType,
      depsDigestByHash,
      skippedAssets,
      error: e instanceof Error ? e : new Error(String(e))
    }
  }

  const totalProbed = cacheResult.cachedHashes.length + cacheResult.missingHashes.length
  const fullCacheHit = totalProbed > 0 && cacheResult.missingHashes.length === 0
  if (fullCacheHit) {
    return { kind: 'full-hit', entity, entityType, cacheResult, depsDigestByHash, skippedAssets }
  }
  return { kind: 'partial-hit', entity, entityType, cacheResult, depsDigestByHash, skippedAssets }
}

/**
 * Publishes the entity manifest and (for scenes) the scene source files for a
 * `full-hit` probe outcome. Centralised so both callers (triage fast-path and
 * conversion fast-path) emit byte-identical client-visible output for the same
 * scene state.
 *
 * Throws on any upload failure. Triage catches and republishes (transient
 * upload errors are usually recoverable on retry). The conversion loop catches,
 * Sentry-captures, and rethrows so the surrounding error handler can fire.
 */
export async function uploadFastPathResult(
  components: Pick<AppComponents, 'logs' | 'cdnS3'>,
  args: {
    entity: Entity
    entityType: string
    contentServerUrl: string
    cdnBucket: string
    manifestFile: string
    entityScopedUploadPath: string
    abVersion: string
    cacheResult: AssetCacheResult
  }
): Promise<void> {
  const {
    entity,
    entityType,
    contentServerUrl,
    cdnBucket,
    manifestFile,
    entityScopedUploadPath,
    abVersion,
    cacheResult
  } = args
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
  // index.js. `entityType === 'scene'` guard mirrors the existing behaviour:
  // wearables/emotes don't carry these source files.
  if (entityType === 'scene') {
    await uploadSceneSourceFilesToCDN(components, entity, contentServerUrl, entityScopedUploadPath, cdnBucket)
  }
  await uploadEntityManifest(components, cdnBucket, manifestFile, manifest)
}
