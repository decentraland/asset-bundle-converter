import { uploadDir } from '@dcl/cdn-uploader'
import { FileVariant } from '@dcl/cdn-uploader/dist/types'
import * as promises from 'fs/promises'
import { rimraf } from 'rimraf'
import { AppComponents } from '../types'
import { runConversion, runLodsConversion } from './run-conversion'
import * as fs from 'fs'
import * as path from 'path'
import { hasContentChange } from './has-content-changed-task'
import { getUnityBuildTarget, normalizeContentsBaseUrl } from '../utils'
import { getActiveEntity } from './fetch-entity-by-pointer'
import fetch from 'node-fetch'
import { classifyHasContentChangeFailure } from './classify-has-content-change-failure'
import { scrubUnityProjectState } from './scrub-unity-project-state'
import {
  checkAssetCache,
  computePerAssetDigests,
  purgeCachedBundlesFromOutput,
  AssetCacheResult,
  SkippedAsset
} from './asset-reuse'



type Manifest = {
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
const CATALYST_FETCH_TIMEOUT_MS = 30_000
// Exit codes aligned with ManifestStatusCode in asset-bundle-registry.
const UNEXPECTED_ERROR_EXIT_CODE = 5
const ALREADY_CONVERTED_EXIT_CODE = 13
const NODE_CAUGHT_ERROR_EXIT_CODE = 14
const NODE_TIMEOUT_EXIT_CODE = 15

async function getCdnBucket(components: Pick<AppComponents, 'config'>) {
  return (await components.config.getString('CDN_BUCKET')) || 'CDN_BUCKET'
}

/**
 * Publish the top-level entity manifest (`manifest/{entityId}[_{target}].json`).
 *
 * Centralized because the `Cache-Control: private, max-age=0, no-cache` header
 * is safety-critical: if it's ever accidentally rewritten to immutable / long
 * max-age, clients will never pick up newly-converted scene hashes. Touching
 * this in exactly one place prevents drift between the short-circuit path and
 * the main path.
 *
 * @param components - Only needs `cdnS3`.
 * @param cdnBucket - Target bucket.
 * @param key - Manifest key, typically produced by `manifestKeyForEntity`.
 * @param manifest - The manifest value to JSON-encode as the body.
 */
async function uploadEntityManifest(
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
 * Case-insensitive boolean env var parser.
 *
 * Accepts the common truthy spellings (`true` / `1` / `yes` / `on`) and the
 * common falsy spellings (`false` / `0` / `no` / `off`). Unrecognized input
 * (e.g. a typo like `ASSET_REUSE_ENABLED=flase`) falls back to `defaultValue`
 * and — when an `onUnrecognized` callback is provided — invokes it so the
 * operator sees the misconfiguration in the logs instead of silently getting
 * the default.
 *
 * Exported for unit testing.
 *
 * @param raw - The raw env value, or undefined/empty for "not set".
 * @param defaultValue - What to return when the input is unset or
 *   unrecognized.
 * @param onUnrecognized - Optional logger callback invoked only on
 *   unrecognized non-empty input. Receives the original raw value.
 * @returns The parsed boolean.
 */
export function parseBooleanFlag(
  raw: string | undefined,
  defaultValue: boolean,
  onUnrecognized?: (raw: string) => void
): boolean {
  if (raw === undefined || raw === '') return defaultValue
  const normalized = raw.trim().toLowerCase()
  if (normalized === 'false' || normalized === '0' || normalized === 'no' || normalized === 'off') return false
  if (normalized === 'true' || normalized === '1' || normalized === 'yes' || normalized === 'on') return true
  if (onUnrecognized) onUnrecognized(raw)
  return defaultValue
}

function manifestKeyForEntity(entityId: string, target: string | undefined) {
  if (target && target !== 'webgl') {
    return `manifest/${entityId}_${target}.json`
  } else {
    return `manifest/${entityId}.json`
  }
}

/**
 * Downloads index.js (main scene script) and main.crdt from the catalyst and uploads them to the CDN bucket.
 * This allows the Explorer desktop client to fetch these critical scene files from S3 instead of the catalyst,
 * avoiding a class of failures where files are missing from the catalyst.
 *
 * Only runs for non-webgl targets (Mac/Windows desktop builds) since those clients use this CDN path.
 */
async function uploadSceneSourceFilesToCDN(
  components: Pick<AppComponents, 'logs' | 'cdnS3'>,
  entity: Awaited<ReturnType<typeof getActiveEntity>>,
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
async function shouldIgnoreConversion(
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

    // ignored when previous version is the same as current version
    // (regardless of exit code — a failed conversion with the same version
    // should not be retried until the converter is updated)
    if (json.version === $AB_VERSION) return true
  } catch {}

  return false
}

export async function executeLODConversion(
  components: Pick<AppComponents, 'logs' | 'metrics' | 'config' | 'cdnS3'>,
  entityId: string,
  lods: string[],
  abVersion: string
): Promise<number> {
  const $LOGS_BUCKET = await components.config.getString('LOGS_BUCKET')
  const $UNITY_PATH = await components.config.requireString('UNITY_PATH')
  const $PROJECT_PATH = await components.config.requireString('PROJECT_PATH')
  const $BUILD_TARGET = await components.config.requireString('BUILD_TARGET')

  const unityBuildTarget = getUnityBuildTarget($BUILD_TARGET)

  const logger = components.logs.getLogger(`ExecuteConversion`)

  const cdnBucket = await getCdnBucket(components)
  const logFile = `/tmp/lods_logs/export_log_${entityId}_${Date.now()}.txt`
  const s3LogKey = `logs/lods/${abVersion}/${entityId}/${new Date().toISOString()}.txt`
  const outDirectory = `/tmp/lods_contents/entity_${entityId}`
  const defaultLoggerMetadata = { entityId, lods, version: abVersion, logFile } as any

  logger.info('Starting conversion for ' + $BUILD_TARGET, defaultLoggerMetadata)

  if (!unityBuildTarget) {
    logger.error('Could not find a build target', { ...defaultLoggerMetadata } as any)
    return UNEXPECTED_ERROR_EXIT_CODE
  }

  await scrubUnityProjectState($PROJECT_PATH, logger, defaultLoggerMetadata)

  try {
    const exitCode = await runLodsConversion(logger, components, {
      entityId,
      logFile,
      outDirectory,
      lods,
      unityPath: $UNITY_PATH,
      projectPath: $PROJECT_PATH,
      timeout: 60 * 60 * 1000,
      unityBuildTarget
    })

    components.metrics.increment('ab_converter_exit_codes', { exit_code: (exitCode ?? -1)?.toString() })

    const generatedFiles = await promises.readdir(outDirectory)

    if (generatedFiles.length === 0) {
      // this is an error, if succeeded, we should see at least a manifest file
      components.metrics.increment('ab_converter_empty_conversion', { ab_version: abVersion })
      logger.error('Empty conversion', { ...defaultLoggerMetadata } as any)
      return UNEXPECTED_ERROR_EXIT_CODE
    }

    await uploadDir(components.cdnS3, cdnBucket, outDirectory, 'LOD', {
      concurrency: 10,
      matches: [
        {
          // the rest of the elements will be uploaded as application/wasm
          // to be compressed and cached by cloudflare
          match: '**/*',
          contentType: 'application/wasm',
          immutable: true,
          variants: [FileVariant.Brotli, FileVariant.Uncompressed],
          skipRepeated: true
        }
      ]
    })

    return exitCode ?? -1
  } catch (error: any) {
    // readFile is wrapped because the log file may not exist (e.g. if
    // setupStartDirectories itself failed). A throw here would propagate
    // through finally and prevent service.ts from publishing the failure
    // event — defeating the catch block's whole purpose of always returning.
    try {
      logger.debug(await promises.readFile(logFile, 'utf8'), defaultLoggerMetadata)
    } catch {}
    const isTimeout = error?.message === 'Process did not finish'
    components.metrics.increment('ab_converter_exit_codes', { exit_code: isTimeout ? 'TIMEOUT' : 'FAIL' })
    logger.error(error)

    // Return a failure exit code instead of rethrowing. The service.ts task
    // runner will publish an AssetBundleConversionFinishedEvent with this
    // statusCode so the registry learns the entity failed, and the worker
    // goes on to pick up the next SQS message.
    return isTimeout ? NODE_TIMEOUT_EXIT_CODE : NODE_CAUGHT_ERROR_EXIT_CODE
  } finally {
    // Finally-block operations must not throw: an uncaught throw here would
    // replace the try/catch's return value and service.ts would skip the
    // event publish, so the registry wouldn't learn about the outcome.
    if ($LOGS_BUCKET) {
      const log = `https://${$LOGS_BUCKET}.s3.amazonaws.com/${s3LogKey}`
      logger.info(`LogFile=${log}`, defaultLoggerMetadata)
      try {
        await components.cdnS3
          .upload({
            Bucket: $LOGS_BUCKET,
            Key: s3LogKey,
            Body: await promises.readFile(logFile),
            ACL: 'public-read'
          })
          .promise()
      } catch (err: any) {
        logger.error(`Failed to upload LOD log file to S3: ${err?.message ?? err}`, defaultLoggerMetadata)
      }
    } else {
      logger.info(`!!!!!!!! Log file not deleted or uploaded ${logFile}`, defaultLoggerMetadata)
    }

    // delete job-specific artefacts
    try {
      await rimraf(logFile, { maxRetries: 3 })
    } catch (err: any) {
      logger.error(err, defaultLoggerMetadata)
    }
    try {
      await rimraf(outDirectory, { maxRetries: 3 })
    } catch (err: any) {
      logger.error(err, defaultLoggerMetadata)
    }

    await scrubUnityProjectState($PROJECT_PATH, logger, defaultLoggerMetadata)
  }

  logger.debug('LOD Conversion finished', defaultLoggerMetadata)
}

export async function executeConversion(
  components: Pick<AppComponents, 'logs' | 'metrics' | 'config' | 'cdnS3' | 'sentry'>,
  entityId: string,
  contentServerUrl: string,
  force: boolean | undefined,
  animation: string | undefined,
  doISS: boolean | undefined,
  abVersion: string
): Promise<number> {
  const $LOGS_BUCKET = await components.config.getString('LOGS_BUCKET')
  const $UNITY_PATH = await components.config.requireString('UNITY_PATH')
  const $PROJECT_PATH = await components.config.requireString('PROJECT_PATH')
  const $BUILD_TARGET = await components.config.requireString('BUILD_TARGET')
  const logger = components.logs.getLogger(`ExecuteConversion`)
  const $ASSET_REUSE_ENABLED = parseBooleanFlag(await components.config.getString('ASSET_REUSE_ENABLED'), true, (raw) =>
    logger.warn(
      `Unrecognized value for ASSET_REUSE_ENABLED: "${raw}" — falling back to the default (true). Accepted values: true/false/1/0/yes/no/on/off.`
    )
  )

  const unityBuildTarget = getUnityBuildTarget($BUILD_TARGET)
  if (!unityBuildTarget) {
    logger.error(`Invalid build target ${$BUILD_TARGET}`)
    return UNEXPECTED_ERROR_EXIT_CODE
  }

  if (!force) {
    if (await shouldIgnoreConversion(components, abVersion, entityId, $BUILD_TARGET)) {
      logger.info('Ignoring conversion', { entityId, contentServerUrl, abVersion })
      return ALREADY_CONVERTED_EXIT_CODE
    }
  } else {
    logger.info('Forcing conversion', { entityId, contentServerUrl, abVersion })
  }

  const cdnBucket = await getCdnBucket(components)
  const manifestFile = manifestKeyForEntity(entityId, $BUILD_TARGET)

  const logFile = `/tmp/asset_bundles_logs/export_log_${entityId}_${Date.now()}.txt`
  const s3LogKey = `logs/${abVersion}/${entityId}/${new Date().toISOString()}.txt`
  const outDirectory = `/tmp/asset_bundles_contents/entity_${entityId}`

  const defaultLoggerMetadata = { entityId, contentServerUrl, version: abVersion, logFile: s3LogKey }

  logger.info('Starting conversion for ' + $BUILD_TARGET, defaultLoggerMetadata)
  await scrubUnityProjectState($PROJECT_PATH, logger, defaultLoggerMetadata)



  // Fetch the entity up-front — needed both for the per-asset cache probe (when
  // enabled) and for uploading scene source files regardless of whether Unity runs.
  // `getActiveEntity` throws on non-200 responses. The `!fetched` guard below
  // is defense-in-depth in case the response parses to null/empty.
  //
  // Timeout: passing CATALYST_FETCH_TIMEOUT_MS prevents a wedged catalyst from
  // holding the worker slot indefinitely. On abort the catch below degrades us
  // to "no entity, no asset-reuse, no source-file upload" — conversion still
  // runs against raw hashes.
  let entityType = 'undefined'
  let entity: Awaited<ReturnType<typeof getActiveEntity>> | null = null
  try {
    const fetched = await getActiveEntity(entityId, contentServerUrl, CATALYST_FETCH_TIMEOUT_MS)
    if (!fetched) throw new Error('entity no longer active on catalyst (redeployed or evicted)')
    entity = fetched
    entityType = entity.type
  } catch (e: any) {
    logger.info(`Could not fetch entity for ${entityId}: ${e?.message ?? e}. Scene manifest wont be generated`)
  }

  // Per-asset reuse: scenes with the kill switch on and no force/ISS short-circuit
  // the pipeline when every asset hash is already canonicalized at
  // `{abVersion}/assets/{hash}_{target}`. Partial hits feed Unity a `-cachedHashes`
  // list so it skips re-converting those GLTFs/buffers. Rollout is staged per build
  // target via the kill switch (each worker pool runs a single target).
  //
  // NOTE on force=true: this path uploads to the entity-scoped prefix, NOT
  // canonical. `force` is for "re-run Unity against this entity's content,"
  // which for content-addressed immutable storage doesn't translate to
  // replacing the canonical bundle — the content hash is the same, so the
  // canonical bundle is by construction the same bytes. If ops need to replace
  // a canonical bundle (e.g. to flush a genuinely corrupt object), the escape
  // hatch is to delete the canonical S3 object directly; the next conversion
  // will upload a fresh copy through the normal reuse path.
  const useAssetReuse = $ASSET_REUSE_ENABLED && !force && !doISS && entityType === 'scene' && !!entity
  const assetReuseUploadPath = abVersion + '/assets'
  const entityScopedUploadPath = abVersion + '/' + entityId

  // Computed eagerly (not from cacheResult) so the glb/gltf composite key stays
  // well-defined even when the probe throws and cacheResult ends up null —
  // otherwise a probe failure would silently reintroduce the hash-only collision
  // bug by asking Unity to emit bare `{hash}_{target}` names. Malformed glTF /
  // network failures fail this step; rather than letting the error propagate
  // past service.ts (where it would be swallowed with no failed-manifest
  // upload and SQS would retry forever against the same broken scene), we
  // treat it as a scene conversion failure: emit the same observability the
  // main catch does, publish the failed-manifest sentinel, and return
  // UNEXPECTED_ERROR.
  let depsDigestByHash: ReadonlyMap<string, string> | undefined
  let skippedAssets: ReadonlyMap<string, SkippedAsset> = new Map()
  if (useAssetReuse && entity) {
    try {
      // 60 s aggregate cap on the digest pass. Each catalyst fetch is already
      // bounded (3 retry attempts × ≤30 s Retry-After clamp), but a scene
      // with dozens of glbs each backing off to the cap could compound past
      // SQS's visibility window. Past this point we throw, fall into the
      // catch below, publish the failed-manifest sentinel, and let SQS
      // retry — preferable to silently holding the worker for minutes.
      const digestResult = await computePerAssetDigests(entity, contentServerUrl, {
        aggregateTimeoutMs: 60_000
      })
      depsDigestByHash = digestResult.digests
      skippedAssets = digestResult.skipped
    } catch (err: any) {
      logger.error(`Per-asset digest computation failed: ${err?.message ?? err}`, defaultLoggerMetadata as any)
      components.metrics.increment('ab_converter_exit_codes', { exit_code: 'FAIL' })
      // captureException (vs captureMessage) so Sentry gets the full error
      // object including stack — the failed-manifest body carries the same
      // message for clients, but Sentry triage needs the stack to find where
      // the throw originated (glb parse? URI escape? catalyst 404?).
      components.sentry.captureException(err, {
        level: 'error',
        tags: {
          entityId,
          contentServerUrl,
          unityBuildTarget,
          version: abVersion,
          phase: 'per-asset-digest'
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
        // If the sentinel upload ALSO fails, we lose the one signal clients
        // have that this scene won't convert. Surface at warn level so ops
        // sees a cascading failure instead of silence.
        logger.warn(
          `Failed to upload failed-manifest sentinel after digest failure: ${uploadErr?.message ?? uploadErr}`,
          defaultLoggerMetadata as any
        )
      }
      return 5 // UNEXPECTED_ERROR exit code
    }
  }

  // Visibility for the skip path: aggregate count + reason-labelled counter so
  // ops can alert on skip-rate spikes without scraping logs. Sample up to five
  // entries into the warn line so a misbehaving scene is diagnosable from the
  // log without a separate per-asset entry; the cap keeps a pathological
  // entity (50+ broken glbs) from blowing the line size.
  //
  // Deliberate Sentry omission: pre-change every broken glb fired
  // `sentry.captureException(... phase: 'per-asset-digest')` from the digest
  // catch above. Per-glb defects are now content-deterministic skips, not
  // exceptions — they no longer warrant a Sentry event per occurrence
  // (would flood triage with thousands of "broken-by-design" entries). The
  // signal moves to `ab_converter_glb_skipped_total{reason}` for alerting;
  // Sentry stays for genuine fetch/infra failures in the digest catch.
  if (skippedAssets.size > 0) {
    // Early-exit collect rather than `[...values()].slice(0, 5)` so a
    // pathological scene (thousands of broken glbs in one entity) doesn't
    // materialize the whole skipped Map into a temporary array just to
    // discard all but the first 5. Cheap defence — Unity's working set is
    // already the dominant memory consumer on these workers.
    const SAMPLE_LIMIT = 5
    const samples: SkippedAsset[] = []
    for (const skip of skippedAssets.values()) {
      if (samples.length >= SAMPLE_LIMIT) break
      samples.push(skip)
    }
    logger.warn('Skipping glb/gltf assets with missing or unparseable dependencies', {
      ...defaultLoggerMetadata,
      count: skippedAssets.size,
      samples: samples.map((s) => ({
        hash: s.hash,
        file: s.file,
        reason: s.reason,
        detail: s.detail
      }))
    } as any)
    for (const skip of skippedAssets.values()) {
      components.metrics.increment('ab_converter_glb_skipped_total', {
        build_target: $BUILD_TARGET,
        ab_version: abVersion,
        reason: skip.reason
      })
    }
  }

  let cacheResult: AssetCacheResult | null = null
  let fullCacheHit = false
  if (useAssetReuse && entity) {
    try {
      cacheResult = await checkAssetCache(components, {
        entity,
        abVersion,
        buildTarget: $BUILD_TARGET,
        cdnBucket,
        depsDigestByHash
      })
      const totalProbed = cacheResult.cachedHashes.length + cacheResult.missingHashes.length
      fullCacheHit = totalProbed > 0 && cacheResult.missingHashes.length === 0
    } catch (e: any) {
      logger.warn(`Asset cache probe failed, falling back to full conversion: ${e.message}`)
      components.metrics.increment('ab_converter_asset_cache_probe_errors_total', {
        build_target: $BUILD_TARGET,
        ab_version: abVersion
      })
      cacheResult = null
    }
  }

  // `fullCacheHit` is only set true inside the `if (useAssetReuse && entity)`
  // block above, so it already implies `useAssetReuse` AND `!!entity`. The
  // `cacheResult` and `entity` checks below are kept purely as TypeScript
  // narrowing guards for the block body.
  if (fullCacheHit && cacheResult && entity) {
    // Full short-circuit: every referenced asset hash is already canonical. Publish
    // the entity manifest pointing at the canonical paths and upload scene source
    // files. No Unity run, no output directory.
    logger.info('All assets cached — skipping Unity', {
      entityId,
      cached: cacheResult.cachedHashes.length
    } as any)

    const files = cacheResult.cachedHashes.map((h) => cacheResult!.canonicalNameByHash[h])
    const manifest: Manifest = {
      version: abVersion,
      files,
      exitCode: 0,
      contentServerUrl,
      date: new Date().toISOString()
    }

    try {
      // Scene source files first, then manifest — matches the main path's ordering
      // so a client that sees a freshly-published manifest never races against a
      // missing main.crdt / scene.json / index.js.
      if (entityType === 'scene') {
        await uploadSceneSourceFilesToCDN(components, entity, contentServerUrl, entityScopedUploadPath, cdnBucket)
      }

      await uploadEntityManifest(components, cdnBucket, manifestFile, manifest)
    } catch (err: any) {
      // Short-circuit failed post-probe. SQS will retry; we capture for visibility
      // because the main-path error handler below never runs.
      components.metrics.increment('ab_converter_exit_codes', { exit_code: 'FAIL' })
      logger.error(err, defaultLoggerMetadata as any)
      components.sentry.captureMessage(`Error during ab short-circuit`, {
        level: 'error',
        tags: {
          entityId,
          contentServerUrl,
          unityBuildTarget,
          version: abVersion,
          shortCircuit: 'true',
          date: new Date().toISOString()
        }
      })
      throw err
    }

    components.metrics.increment('ab_converter_asset_reuse_short_circuit_total', {
      build_target: $BUILD_TARGET,
      ab_version: abVersion
    })
    components.metrics.increment('ab_converter_exit_codes', { exit_code: '0' })

    return 0
  }

  // Secondary legacy fast-path (scene-level content-match check). Only runs when the
  // new per-asset reuse didn't short-circuit. Gated on `entityType === 'scene'`
  // because `hasContentChange` immediately returns true for non-scenes after a
  // duplicate catalyst fetch — we skip the wasted round-trip here. Left in place
  // intentionally — removing it is a separate follow-up after the new path is
  // proven in production.
  let hasContentChanged = true
  if ($BUILD_TARGET !== 'webgl' && !force && !doISS && !useAssetReuse && entityType === 'scene') {
    try {
      hasContentChanged = await hasContentChange(
        entityId,
        contentServerUrl,
        $BUILD_TARGET,
        outDirectory,
        abVersion,
        logger
      )
    } catch (e: any) {
      // Upstream (content-server) failure — we fall back to reconverting, which
      // can produce a reconversion loop for entities whose content-server
      // endpoints are broken. Tag the metric with the reason so the failure mode
      // is visible in Grafana.
      const reason = classifyHasContentChangeFailure(e)
      components.metrics.increment('ab_converter_has_content_change_failures', { reason })
      logger.warn(`HasContentChanged failed (${reason}), falling back to reconvert: ${e?.message ?? e}`, {
        ...defaultLoggerMetadata,
        contentServerUrl
      } as any)
    }
    logger.info(`HasContentChanged for ${entityId} result was ${hasContentChanged}`)
  }

  let exitCode
  try {
    if (hasContentChanged) {
      exitCode = await runConversion(logger, components, {
        contentServerUrl,
        entityId,
        entityType,
        logFile,
        outDirectory,
        projectPath: $PROJECT_PATH,
        unityPath: $UNITY_PATH,
        timeout: 120 * 60 * 1000, // 120min temporarily doubled
        unityBuildTarget: unityBuildTarget,
        animation: animation,
        doISS: doISS,
        cachedHashes: useAssetReuse && cacheResult ? cacheResult.unitySkippableHashes : undefined,
        skippedHashes: skippedAssets.size > 0 ? [...skippedAssets.keys()] : undefined,
        depsDigestByHash
      })
    } else {
      exitCode = 0
    }

    components.metrics.increment('ab_converter_exit_codes', { exit_code: (exitCode ?? -1)?.toString() })

    // When asset reuse is active, drop any cached-hash bundles that Unity produced
    // anyway (either because the extension was not in the skippable set, or because
    // the list bypass didn't cover every artifact). The canonical object already
    // exists, so re-uploading would just be wasted work.
    if (useAssetReuse && cacheResult && cacheResult.cachedHashes.length > 0) {
      const purged = await purgeCachedBundlesFromOutput(outDirectory, cacheResult.cachedHashes, logger)
      if (purged > 0) {
        logger.info(`Purged ${purged} already-canonical bundle file(s) from output directory`)
      }
    }

    const manifest: Manifest = {
      version: abVersion,
      files: await promises.readdir(outDirectory),
      exitCode,
      contentServerUrl,
      date: new Date().toISOString()
    }

    // Top-level entity manifest must advertise every hash that resolves — including
    // the cached ones we intentionally did not produce locally. The canonical name
    // (composite for glb/gltf, bare for BINs/textures) comes from the probe result.
    if (useAssetReuse && cacheResult && cacheResult.cachedHashes.length > 0) {
      const seen = new Set(manifest.files)
      for (const hash of cacheResult.cachedHashes) {
        const bundleName = cacheResult.canonicalNameByHash[hash]
        if (bundleName && !seen.has(bundleName)) manifest.files.push(bundleName)
      }
    }

    logger.debug('Manifest', { ...defaultLoggerMetadata, manifest } as any)

    if (manifest.files.length === 0) {
      // this is an error, if succeeded, we should see at least a manifest file
      components.metrics.increment('ab_converter_empty_conversion', { ab_version: abVersion })
      logger.error('Empty conversion', { ...defaultLoggerMetadata, manifest } as any)
    }

    const bundleUploadPath = useAssetReuse ? assetReuseUploadPath : entityScopedUploadPath

    // first upload the content (bundles go to the canonical prefix when reuse is on)
    await uploadDir(components.cdnS3, cdnBucket, outDirectory, bundleUploadPath, {
      concurrency: 10,
      matches: [
        {
          match: '**/*.manifest',
          contentType: 'text/cache-manifest',
          immutable: true,
          variants: [FileVariant.Brotli, FileVariant.Uncompressed]
        },
        {
          // the rest of the elements will be uploaded as application/wasm
          // to be compressed and cached by cloudflare
          match: '**/*',
          contentType: 'application/wasm',
          immutable: true,
          variants: [FileVariant.Brotli, FileVariant.Uncompressed],
          skipRepeated: true
        }
      ]
    })

    logger.debug('Content files uploaded', defaultLoggerMetadata)

    // Upload index.js and main.crdt to CDN so the desktop Explorer client
    // can fetch them from S3 instead of the catalyst (see issue #7625).
    // Scene source files stay entity-scoped regardless of reuse mode.
    if (entity && exitCode === 0 && entityType === 'scene') {
      await uploadSceneSourceFilesToCDN(components, entity, contentServerUrl, entityScopedUploadPath, cdnBucket)
    }

    // and then replace the manifest
    await uploadEntityManifest(components, cdnBucket, manifestFile, manifest)

    if (exitCode !== 0 || manifest.files.length === 0) {
      const log = await promises.readFile(logFile, 'utf8')

      logger.debug(log, defaultLoggerMetadata)

      if (log.includes('You must have a valid X server running')) {
        // if X server is having trouble, we will kill the service right away. without further ado
        // this will make the job to timeout and to be re-processed by the SQS queue
        logger.error('X server is having trouble, the service will restart')
        process.exit(1)
      }
    }

    return exitCode ?? -1
  } catch (err: any) {
    // readFile is wrapped because the log file may not exist (e.g. if
    // setupStartDirectories itself failed). A throw here would propagate
    // through finally and prevent service.ts from publishing the failure
    // event — defeating the catch block's whole purpose of always returning.
    try {
      logger.debug(await promises.readFile(logFile, 'utf8'), defaultLoggerMetadata)
    } catch {}

    const isTimeout = err?.message === 'Process did not finish'
    const failedExitCode = isTimeout ? NODE_TIMEOUT_EXIT_CODE : NODE_CAUGHT_ERROR_EXIT_CODE

    components.metrics.increment('ab_converter_exit_codes', { exit_code: isTimeout ? 'TIMEOUT' : 'FAIL' })
    logger.error(err)

    components.sentry.captureMessage(`Error during ab conversion`, {
      level: 'error',
      tags: {
        entityId,
        contentServerUrl,
        unityBuildTarget,
        // Nullish coalescing instead of `||`: a successful-but-post-upload-failing
        // run has exitCode === 0 and we want Sentry to report 0, not 'unknown'.
        unityExitCode: exitCode ?? 'unknown',
        version: abVersion,
        log: s3LogKey,
        date: new Date().toISOString()
      }
    })

    // Upload a failed manifest to the main manifest key so that
    // shouldIgnoreConversion can find it and skip re-processing the same
    // entity with the same converter version.
    try {
      const manifest: Manifest = {
        version: abVersion,
        files: [],
        exitCode: failedExitCode,
        contentServerUrl,
        date: new Date().toISOString()
      }
      await components.cdnS3
        .upload({
          Bucket: cdnBucket,
          Key: manifestFile,
          ContentType: 'application/json',
          Body: JSON.stringify(manifest),
          CacheControl: 'private, max-age=0, no-cache',
          ACL: 'public-read'
        })
        .promise()
    } catch {}

    // Return a failure exit code instead of rethrowing. The service.ts task
    // runner will publish an AssetBundleConversionFinishedEvent with this
    // statusCode so the registry learns the entity failed, and the worker
    // goes on to pick up the next SQS message.
    return failedExitCode
  } finally {
    // Finally-block operations must not throw: an uncaught throw here would
    // replace the try/catch's return value and service.ts would skip the
    // event publish, so the registry wouldn't learn about the outcome.
    if ($LOGS_BUCKET && hasContentChanged) {
      const log = `https://${$LOGS_BUCKET}.s3.amazonaws.com/${s3LogKey}`
      logger.info(`LogFile=${log}`, defaultLoggerMetadata)
      try {
        await components.cdnS3
          .upload({
            Bucket: $LOGS_BUCKET,
            Key: s3LogKey,
            Body: await promises.readFile(logFile),
            ACL: 'public-read'
          })
          .promise()
      } catch (err: any) {
        logger.error(`Failed to upload log file to S3: ${err?.message ?? err}`, defaultLoggerMetadata)
      }
    } else {
      logger.info(`!!!!!!!! Log file not deleted or uploaded ${logFile}`, defaultLoggerMetadata)
    }

    // delete job-specific artefacts
    try {
      await rimraf(logFile, { maxRetries: 3 })
    } catch (err: any) {
      logger.error(err, defaultLoggerMetadata)
    }
    try {
      await rimraf(outDirectory, { maxRetries: 3 })
    } catch (err: any) {
      logger.error(err, defaultLoggerMetadata)
    }

    await scrubUnityProjectState($PROJECT_PATH, logger, defaultLoggerMetadata)
  }

  logger.debug('Conversion finished', defaultLoggerMetadata)
  logger.debug(`Full project size ${getFolderSize($PROJECT_PATH)}`)
  printFolderSizes($PROJECT_PATH, logger)
}

/**
 * Recursively calculates the size of a directory in bytes.
 * @param dirPath - The path to the directory.
 * @returns The size of the directory in bytes.
 */
function getFolderSize(dirPath: string): number {
  let totalSize = 0

  const files = fs.readdirSync(dirPath)
  for (const file of files) {
    const filePath = path.join(dirPath, file)
    const stats = fs.statSync(filePath)

    if (stats.isDirectory()) {
      totalSize += getFolderSize(filePath) // Recursively add the size of subdirectories
    } else {
      totalSize += stats.size
    }
  }

  return totalSize
}

/**
 * Recursively iterates through each folder and subfolder, printing its size.
 * @param dirPath - The path to the directory.
 * @param logger - The used logger.
 * @param depth - The max depth of folder size logging.
 */
function printFolderSizes(dirPath: string, logger: any, depth: number = 0): void {
  const stats = fs.statSync(dirPath)

  if (stats.isDirectory()) {
    const folderSize = getFolderSize(dirPath)
    logger.debug(`Unity Folder: ${dirPath} - Size: ${(folderSize / (1024 * 1024)).toFixed(2)} MB`)

    if (depth < 2) {
      const files = fs.readdirSync(dirPath)
      for (const file of files) {
        const filePath = path.join(dirPath, file)
        if (fs.statSync(filePath).isDirectory()) {
          printFolderSizes(filePath, logger, depth + 1) // Increment depth by 1 for the next level
        }
      }
    }
  }
}
