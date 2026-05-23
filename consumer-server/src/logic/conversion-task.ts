import { uploadDir } from '@dcl/cdn-uploader'
import { FileVariant } from '@dcl/cdn-uploader/dist/types'
import { ILoggerComponent } from '@well-known-components/interfaces'
import * as promises from 'fs/promises'
import { rimraf } from 'rimraf'
import { Entity } from '@dcl/schemas'
import { AppComponents } from '../types'
import * as fs from 'fs'
import * as path from 'path'
import { hasContentChange } from './has-content-changed-task'
import { getUnityBuildTarget, withPhaseTimer } from '../utils'
import { AssetCacheResult, findMetadataOnlyHashes, SkippedAsset } from './asset-reuse'
import { Manifest } from './scenes'

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

/**
 * Per-glb skip visibility: aggregate count + reason-labelled counter so ops
 * can alert on skip-rate spikes without scraping logs. Samples up to five
 * entries into the warn line so a misbehaving scene is diagnosable from the
 * log without a separate per-asset entry; the cap keeps a pathological entity
 * (50+ broken glbs) from blowing the line size.
 *
 * Deliberate Sentry omission: per-glb defects are content-deterministic skips,
 * not exceptions — flooding Sentry with thousands of "broken-by-design" entries
 * doesn't help triage. The signal moves to `ab_converter_glb_skipped_total`.
 *
 * Conversion-loop only — `executeTriagePass` deliberately doesn't log skipped
 * assets (they get republished and surfaced by the conversion-loop call).
 */
function logSkippedAssetsSample(
  components: Pick<AppComponents, 'metrics'>,
  logger: ILoggerComponent.ILogger,
  args: {
    defaultLoggerMetadata: Record<string, unknown>
    skippedAssets: ReadonlyMap<string, SkippedAsset>
    buildTarget: string
    abVersion: string
  }
): void {
  const { defaultLoggerMetadata, skippedAssets, buildTarget, abVersion } = args
  if (skippedAssets.size === 0) return

  // Early-exit collect rather than `[...values()].slice(0, 5)` so a pathological
  // scene (thousands of broken glbs in one entity) doesn't materialize the whole
  // skipped Map into a temporary array just to discard all but the first 5.
  const SAMPLE_LIMIT = 5
  const samples: SkippedAsset[] = []
  for (const skip of skippedAssets.values()) {
    if (samples.length >= SAMPLE_LIMIT) break
    samples.push(skip)
  }
  // Cast: the logger's typed `extra` is `Record<string, string | number>`, but
  // observability historically writes nested structured data here. Matches the
  // pre-refactor `as any` at the original call site.
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
      build_target: buildTarget,
      ab_version: abVersion,
      reason: skip.reason
    })
  }
}

/**
 * Outcome of a triage pass over a conversion job.
 *
 * - `completed`: the triage loop fully handled the job. Either the manifest
 *   indicated it was already converted (`exitCode: 13`), or every per-asset
 *   hash was already canonical and the scene source files + manifest were
 *   uploaded inline (`exitCode: 0`). In both cases the triage loop publishes
 *   the AssetBundleConversionFinishedEvent and acks the message — no Unity
 *   needed, no Conversion-queue republish.
 * - `needs-unity`: triage cannot complete the job. The triage loop should
 *   republish the job to the Conversion queue and ack the triage message;
 *   the conversion loop will eventually pick it up. No finished event is
 *   published yet — the conversion loop will publish it after the
 *   conversion completes.
 * - `failed`: the probe itself errored (e.g., per-asset digest computation
 *   threw). A failed-manifest sentinel has already been uploaded so clients
 *   can see the failure. The triage loop should ack but skip republishing.
 */
export type TriagePassOutcome =
  | { kind: 'completed'; exitCode: number }
  | { kind: 'needs-unity' }
  | { kind: 'failed'; exitCode: number }

/**
 * Probe-only path used by the triage loop. Delegates to {@link probeScene}
 * for the shared probe pipeline (build-target validation, shouldIgnore
 * short-circuit, catalyst fetch, per-asset digest, cache probe, full-hit
 * detection) and maps the {@link ProbeOutcome} variants to the
 * {@link TriagePassOutcome} shape the triage loop expects.
 *
 * Force / ISS short-circuit *before* the probe runs: these always need
 * Unity, so paying for the catalyst fetch and digest pass would be wasted
 * work. The conversion loop's subsequent `executeConversion` call does its
 * own probe (and its own catalyst fetch), so no state is lost.
 *
 * Triage-specific responsibilities that stay here (don't push into the
 * shared probe):
 * - Emitting `ab_converter_triage_outcomes_total` per branch.
 * - The fast-path upload's soft-failure recovery (return needs-unity so the
 *   conversion loop can retry); `executeConversion` rethrows instead.
 */
export async function executeTriagePass(
  components: Pick<AppComponents, 'logs' | 'metrics' | 'config' | 'cdnS3' | 'sentry' | 'catalyst' | 'scenes'>,
  entityId: string,
  contentServerUrl: string,
  force: boolean | undefined,
  doISS: boolean | undefined,
  abVersion: string
): Promise<TriagePassOutcome> {
  const $BUILD_TARGET = await components.config.requireString('BUILD_TARGET')
  const logger = components.logs.getLogger('ExecuteTriagePass')
  const $ASSET_REUSE_ENABLED = parseBooleanFlag(await components.config.getString('ASSET_REUSE_ENABLED'), true, (raw) =>
    logger.warn(
      `Unrecognized value for ASSET_REUSE_ENABLED: "${raw}" — falling back to the default (true). Accepted values: true/false/1/0/yes/no/on/off.`
    )
  )

  // Force / ISS short-circuit: these always need Unity (force is "redo this
  // entity from scratch"; ISS is the v2004 special-case version). Skip the
  // probe entirely — pay zero catalyst / S3 / digest cost when we know the
  // outcome upfront.
  if (force || doISS) {
    components.metrics.increment('ab_converter_triage_outcomes_total', {
      build_target: $BUILD_TARGET,
      outcome: 'republished'
    })
    return { kind: 'needs-unity' }
  }

  const outcome = await components.scenes.probe({
    entityId,
    contentServerUrl,
    abVersion,
    buildTarget: $BUILD_TARGET,
    force: false,
    assetReuseEnabled: $ASSET_REUSE_ENABLED,
    // doISS already short-circuited above; this is reachable only with doISS=false.
    doISS: false,
    sentryPhase: 'triage-per-asset-digest'
  })

  // Note: the conversion loop's `executeConversion` has a parallel switch on
  // `ProbeOutcome` with different return-shape semantics (numeric exit code vs
  // TriagePassOutcome) and different metric taxonomy (`ab_converter_exit_codes`
  // / `asset_cache_probe_errors_total` vs `triage_outcomes_total`). When
  // changing how a ProbeOutcome variant is handled, mirror the change in
  // `executeConversion` (this file, ~line 489) so the two consumers stay in
  // step on shared behaviour like force/doISS short-circuiting and digest
  // failure handling.
  switch (outcome.kind) {
    case 'invalid-build-target':
      return { kind: 'failed', exitCode: 5 }

    case 'already-converted':
      components.metrics.increment('ab_converter_triage_outcomes_total', {
        build_target: $BUILD_TARGET,
        outcome: 'already_converted'
      })
      return { kind: 'completed', exitCode: 13 }

    case 'catalyst-unreachable':
    case 'no-asset-reuse':
    case 'partial-hit':
      components.metrics.increment('ab_converter_triage_outcomes_total', {
        build_target: $BUILD_TARGET,
        outcome: 'republished'
      })
      return { kind: 'needs-unity' }

    case 'cache-probe-failed':
      components.metrics.increment('ab_converter_asset_cache_probe_errors_total', {
        build_target: $BUILD_TARGET,
        ab_version: abVersion
      })
      components.metrics.increment('ab_converter_triage_outcomes_total', {
        build_target: $BUILD_TARGET,
        outcome: 'republished'
      })
      return { kind: 'needs-unity' }

    case 'digest-failed':
      // probeScene already uploaded the failed-manifest sentinel and notified Sentry.
      components.metrics.increment('ab_converter_exit_codes', { exit_code: 'FAIL' })
      components.metrics.increment('ab_converter_triage_outcomes_total', {
        build_target: $BUILD_TARGET,
        outcome: 'failed'
      })
      return { kind: 'failed', exitCode: 5 }

    case 'cache-probe-skipped':
      // Cannot occur — triage short-circuits force upstream so probeScene is
      // never invoked with force=true. The branch is here for exhaustiveness;
      // treat it conservatively as "needs Unity" if a future refactor changes
      // the upstream gate.
      components.metrics.increment('ab_converter_triage_outcomes_total', {
        build_target: $BUILD_TARGET,
        outcome: 'republished'
      })
      return { kind: 'needs-unity' }

    case 'full-hit': {
      logger.info('Triage: all assets cached — fast-path completing', {
        entityId,
        cached: outcome.cacheResult.cachedHashes.length
      } as any)
      const cdnBucket = await components.scenes.getCdnBucket()
      try {
        await components.scenes.uploadFastPathResult({
          entity: outcome.entity,
          contentServerUrl,
          cdnBucket,
          manifestFile: components.scenes.manifestKeyForEntity(entityId, $BUILD_TARGET),
          entityScopedUploadPath: `${abVersion}/${entityId}`,
          abVersion,
          cacheResult: outcome.cacheResult
        })
      } catch (err: any) {
        // Same-pod upload errors are usually transient. Republish so the
        // conversion loop can retry the upload (and possibly run Unity if the
        // cache state has changed). executeConversion rethrows in this case;
        // triage soft-recovers because lost work is the worse failure mode
        // when the conversion queue can simply retry.
        components.metrics.increment('ab_converter_exit_codes', { exit_code: 'FAIL' })
        logger.error(err, { entityId, contentServerUrl, version: abVersion } as any)
        components.sentry.captureMessage(`Error during triage fast-path upload`, {
          level: 'error',
          tags: {
            entityId,
            contentServerUrl,
            unityBuildTarget: getUnityBuildTarget($BUILD_TARGET) ?? '',
            version: abVersion,
            phase: 'triage-fast-path-upload',
            date: new Date().toISOString()
          }
        })
        components.metrics.increment('ab_converter_triage_outcomes_total', {
          build_target: $BUILD_TARGET,
          outcome: 'republished'
        })
        return { kind: 'needs-unity' }
      }
      components.metrics.increment('ab_converter_asset_reuse_short_circuit_total', {
        build_target: $BUILD_TARGET,
        ab_version: abVersion
      })
      components.metrics.increment('ab_converter_exit_codes', { exit_code: '0' })
      components.metrics.increment('ab_converter_triage_outcomes_total', {
        build_target: $BUILD_TARGET,
        outcome: 'fast_path'
      })
      return { kind: 'completed', exitCode: 0 }
    }
  }
}

export async function executeLODConversion(
  components: Pick<AppComponents, 'logs' | 'metrics' | 'config' | 'cdnS3' | 'unityRunner' | 'scenes'>,
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

  const cdnBucket = await components.scenes.getCdnBucket()
  const logFile = `/tmp/lods_logs/export_log_${entityId}_${Date.now()}.txt`
  const s3LogKey = `logs/lods/${abVersion}/${entityId}/${new Date().toISOString()}.txt`
  const outDirectory = `/tmp/lods_contents/entity_${entityId}`
  const defaultLoggerMetadata = { entityId, lods, version: abVersion, logFile } as any

  logger.info('Starting conversion for ' + $BUILD_TARGET, defaultLoggerMetadata)

  if (!unityBuildTarget) {
    logger.error('Could not find a build target', { ...defaultLoggerMetadata } as any)
    return 5 // UNEXPECTED_ERROR exit code
  }

  try {
    const exitCode = await withPhaseTimer(
      components.metrics,
      'ab_converter_phase_unity_seconds',
      { build_target: $BUILD_TARGET, ab_version: abVersion },
      () =>
        components.unityRunner.runLodsConversion({
          entityId,
          logFile,
          outDirectory,
          lods,
          unityPath: $UNITY_PATH,
          projectPath: $PROJECT_PATH,
          timeout: 60 * 60 * 1000,
          unityBuildTarget
        })
    )

    components.metrics.increment('ab_converter_exit_codes', { exit_code: (exitCode ?? -1)?.toString() })

    const generatedFiles = await promises.readdir(outDirectory)

    if (generatedFiles.length === 0) {
      // this is an error, if succeeded, we should see at least a manifest file
      components.metrics.increment('ab_converter_empty_conversion', { ab_version: abVersion })
      logger.error('Empty conversion', { ...defaultLoggerMetadata } as any)
      return 5 // UNEXPECTED_ERROR exit code
    }

    await withPhaseTimer(
      components.metrics,
      'ab_converter_phase_upload_seconds',
      { build_target: $BUILD_TARGET, ab_version: abVersion },
      () =>
        uploadDir(components.cdnS3, cdnBucket, outDirectory, 'LOD', {
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
    )

    return exitCode ?? -1
  } catch (error: any) {
    logger.debug(await promises.readFile(logFile, 'utf8'), defaultLoggerMetadata)
    components.metrics.increment('ab_converter_exit_codes', { exit_code: 'FAIL' })
    logger.error(error)

    setTimeout(() => {
      // kill the process in one minute, enough time to allow prometheus to collect the metrics
      process.exit(199)
    }, 60_000)

    throw error
  } finally {
    if ($LOGS_BUCKET) {
      const log = `https://${$LOGS_BUCKET}.s3.amazonaws.com/${s3LogKey}`

      logger.info(`LogFile=${log}`, defaultLoggerMetadata)
      await components.cdnS3
        .upload({
          Bucket: $LOGS_BUCKET,
          Key: s3LogKey,
          Body: await promises.readFile(logFile),
          ACL: 'public-read'
        })
        .promise()
    } else {
      logger.info(`!!!!!!!! Log file not deleted or uploaded ${logFile}`, defaultLoggerMetadata)
    }

    await withPhaseTimer(
      components.metrics,
      'ab_converter_phase_cleanup_seconds',
      { build_target: $BUILD_TARGET, ab_version: abVersion },
      async () => {
        // delete output files
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
        // delete library folder
        try {
          await rimraf(`${$PROJECT_PATH}/Library`, { maxRetries: 3 })
        } catch (err: any) {
          logger.error(err, defaultLoggerMetadata)
        }

        // delete scene manifest folder
        await deleteSceneManifestFolder($PROJECT_PATH, logger, defaultLoggerMetadata)
      }
    )
  }

  logger.debug('LOD Conversion finished', defaultLoggerMetadata)
}

/**
 * Full conversion path: probe → fast-path-or-Unity → upload → manifest.
 *
 * Delegates the probe portion (build-target validation, shouldIgnore
 * short-circuit, catalyst fetch, per-asset digest, cache probe, full-hit
 * detection) to {@link probeScene}; the same helper backs `executeTriagePass`,
 * so the two paths can't drift apart. This function owns the Unity spawn,
 * post-Unity uploads, and conversion-loop-specific error handling that the
 * probe outcome doesn't cover.
 */
export async function executeConversion(
  components: Pick<
    AppComponents,
    'logs' | 'metrics' | 'config' | 'cdnS3' | 'sentry' | 'catalyst' | 'unityRunner' | 'scenes'
  >,
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

  // unityBuildTarget is also computed inside probeScene's validation step, but
  // we need it here for the Sentry tags on the Unity-path error handler below.
  // We narrow to non-undefined ourselves because probeScene returns the
  // 'invalid-build-target' variant on the same condition and we'll short-circuit
  // on that variant below; non-null assertion after the switch would also work,
  // but a typed assertion here lets the Sentry tag literals stay clean.
  const unityBuildTarget = getUnityBuildTarget($BUILD_TARGET) ?? ''

  if (force) {
    logger.info('Forcing conversion', { entityId, contentServerUrl, abVersion })
  }

  const cdnBucket = await components.scenes.getCdnBucket()
  const manifestFile = components.scenes.manifestKeyForEntity(entityId, $BUILD_TARGET)
  const failedManifestFile = `manifest/${entityId}_failed.json`

  const logFile = `/tmp/asset_bundles_logs/export_log_${entityId}_${Date.now()}.txt`
  const s3LogKey = `logs/${abVersion}/${entityId}/${new Date().toISOString()}.txt`
  const outDirectory = `/tmp/asset_bundles_contents/entity_${entityId}`

  const defaultLoggerMetadata = { entityId, contentServerUrl, version: abVersion, logFile: s3LogKey }

  logger.info('Starting conversion for ' + $BUILD_TARGET, defaultLoggerMetadata)

  const outcome = await components.scenes.probe({
    entityId,
    contentServerUrl,
    abVersion,
    buildTarget: $BUILD_TARGET,
    force: !!force,
    assetReuseEnabled: $ASSET_REUSE_ENABLED,
    doISS: !!doISS
  })

  // Unity-path state populated from the probe outcome. `useAssetReuse` is
  // inferred from the outcome variant rather than re-derived from inputs:
  // probeScene ANDs in `entity.type === 'scene' && !!entity` for us.
  let entity: Entity | null = null
  let entityType = 'undefined'
  let depsDigestByHash: ReadonlyMap<string, string> | undefined
  let skippedAssets: ReadonlyMap<string, SkippedAsset> = new Map()
  let cacheResult: AssetCacheResult | null = null
  let useAssetReuse = false

  // Note: the triage loop's `executeTriagePass` (this file, ~line 194) has a
  // parallel switch on `ProbeOutcome` with different return-shape semantics
  // (TriagePassOutcome union vs numeric exit code) and different metric
  // taxonomy. When changing how a ProbeOutcome variant is handled, mirror the
  // change there so the two consumers stay in step on shared behaviour like
  // force/doISS short-circuiting and digest failure handling.
  switch (outcome.kind) {
    case 'invalid-build-target':
      return 5 // UNEXPECTED_ERROR exit code

    case 'already-converted':
      return 13 // ALREADY_CONVERTED exit code

    case 'digest-failed':
      // probeScene already uploaded the failed-manifest sentinel and notified
      // Sentry. Emit the same FAIL exit_code counter the pre-refactor path did
      // before returning so dashboards see the failure.
      components.metrics.increment('ab_converter_exit_codes', { exit_code: 'FAIL' })
      return 5 // UNEXPECTED_ERROR exit code

    case 'catalyst-unreachable':
      // Same graceful degradation as the pre-refactor catch: keep going against
      // raw hashes. entity stays null, useAssetReuse stays false, no source
      // files post-success.
      logger.info(`Could not fetch entity for ${entityId}: ${outcome.error.message}. Scene manifest wont be generated`)
      break

    case 'no-asset-reuse':
      entity = outcome.entity
      entityType = outcome.entityType
      break

    // The next three variants — cache-probe-skipped, cache-probe-failed,
    // partial-hit — only arise when the probe got past its
    // `entity.type === 'scene'` gate, so the local entityType is always
    // 'scene' here. We assign it explicitly rather than re-reading from the
    // outcome (which would carry redundant per-variant typing).
    case 'cache-probe-skipped':
      // force=true honoured: digests were computed for canonical paths, but
      // the cache probe was skipped so cachedHashes stays empty and Unity
      // re-converts everything.
      entity = outcome.entity
      entityType = 'scene'
      depsDigestByHash = outcome.depsDigestByHash
      skippedAssets = outcome.skippedAssets
      useAssetReuse = true
      break

    case 'cache-probe-failed':
      components.metrics.increment('ab_converter_asset_cache_probe_errors_total', {
        build_target: $BUILD_TARGET,
        ab_version: abVersion
      })
      entity = outcome.entity
      entityType = 'scene'
      depsDigestByHash = outcome.depsDigestByHash
      skippedAssets = outcome.skippedAssets
      useAssetReuse = true
      break

    case 'partial-hit':
      entity = outcome.entity
      entityType = 'scene'
      cacheResult = outcome.cacheResult
      depsDigestByHash = outcome.depsDigestByHash
      skippedAssets = outcome.skippedAssets
      useAssetReuse = true
      break

    case 'full-hit': {
      // Surface skipped-asset visibility before the early return so a
      // pathological scene that happens to fully cache-hit still emits the
      // skip metrics for ops alerting. Matches pre-refactor behaviour.
      logSkippedAssetsSample(components, logger, {
        defaultLoggerMetadata,
        skippedAssets: outcome.skippedAssets,
        buildTarget: $BUILD_TARGET,
        abVersion
      })
      logger.info('All assets cached — skipping Unity', {
        entityId,
        cached: outcome.cacheResult.cachedHashes.length
      } as any)
      try {
        await withPhaseTimer(
          components.metrics,
          'ab_converter_phase_upload_seconds',
          { build_target: $BUILD_TARGET, ab_version: abVersion },
          () =>
            components.scenes.uploadFastPathResult({
              entity: outcome.entity,
              contentServerUrl,
              cdnBucket,
              manifestFile,
              entityScopedUploadPath: `${abVersion}/${entityId}`,
              abVersion,
              cacheResult: outcome.cacheResult
            })
        )
      } catch (err: any) {
        // Short-circuit failed post-probe. SQS will retry; capture for
        // visibility because the main-path error handler below never runs.
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
  }

  // Unity-path entry. The probe didn't short-circuit, so we'll run a real
  // conversion. Surface skipped-asset visibility now (the full-hit branch
  // handled it inline above).
  logSkippedAssetsSample(components, logger, {
    defaultLoggerMetadata,
    skippedAssets,
    buildTarget: $BUILD_TARGET,
    abVersion
  })

  // Hashes that Unity should drop from texturePaths / gltfPaths / bufferPaths
  // before any download: union of (a) broken glbs flagged by the digester and
  // (b) metadata-only files (SDK thumbnails, navmap thumbnail) whose bundles
  // the runtime never imports. Same `-skippedHashes` CLI flag carries both
  // categories — the Unity-side filter is identical (RemoveAll), so we don't
  // need parallel flags. See `findMetadataOnlyHashes` JSDoc for the
  // classification rules and the false-negative trade-off.
  //
  // Prefer the set already computed by `checkAssetCache` (returned on
  // `cacheResult.metadataOnlyHashes`) to avoid recomputing regex + metadata
  // walks. Falls back to deriving from `entity` when there's no probe — the
  // legacy path with `ASSET_REUSE_ENABLED=false` and any future caller that
  // wants the filter without running the probe.
  const metadataOnlyHashes: ReadonlySet<string> =
    cacheResult?.metadataOnlyHashes ??
    (entity ? findMetadataOnlyHashes(entity.content, entity.metadata) : new Set<string>())
  const unityDropHashes = new Set<string>([...skippedAssets.keys(), ...metadataOnlyHashes])
  if (metadataOnlyHashes.size > 0) {
    logger.info('Dropping metadata-only files from Unity input', {
      ...defaultLoggerMetadata,
      count: metadataOnlyHashes.size,
      hashes: [...metadataOnlyHashes]
    } as any)
  }

  const assetReuseUploadPath = abVersion + '/assets'
  const entityScopedUploadPath = abVersion + '/' + entityId

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
        components.catalyst,
        entityId,
        contentServerUrl,
        $BUILD_TARGET,
        outDirectory,
        abVersion,
        logger
      )
    } catch (e) {
      logger.info('HasContentChanged failed with error ' + e)
    }
    logger.info(`HasContentChanged for ${entityId} result was ${hasContentChanged}`)
  }

  let exitCode: number | undefined
  try {
    if (hasContentChanged) {
      exitCode = await withPhaseTimer(
        components.metrics,
        'ab_converter_phase_unity_seconds',
        { build_target: $BUILD_TARGET, ab_version: abVersion },
        () =>
          components.unityRunner.runConversion({
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
            skippedHashes: unityDropHashes.size > 0 ? [...unityDropHashes] : undefined,
            depsDigestByHash
          })
      )
    } else {
      exitCode = 0
    }

    components.metrics.increment('ab_converter_exit_codes', { exit_code: (exitCode ?? -1)?.toString() })

    // When asset reuse is active, drop any cached-hash bundles that Unity produced
    // anyway (either because the extension was not in the skippable set, or because
    // the list bypass didn't cover every artifact). The canonical object already
    // exists, so re-uploading would just be wasted work.
    if (useAssetReuse && cacheResult && cacheResult.cachedHashes.length > 0) {
      const purged = await components.scenes.purgeCachedBundlesFromOutput(outDirectory, cacheResult.cachedHashes)
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

    await withPhaseTimer(
      components.metrics,
      'ab_converter_phase_upload_seconds',
      { build_target: $BUILD_TARGET, ab_version: abVersion },
      async () => {
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
          await components.scenes.uploadSceneSourceFilesToCDN(
            entity,
            contentServerUrl,
            entityScopedUploadPath,
            cdnBucket
          )
        }

        // and then replace the manifest
        await components.scenes.uploadEntityManifest(cdnBucket, manifestFile, manifest)
      }
    )

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
    logger.debug(await promises.readFile(logFile, 'utf8'), defaultLoggerMetadata)
    components.metrics.increment('ab_converter_exit_codes', { exit_code: 'FAIL' })
    logger.error(err)

    components.sentry.captureMessage(`Error during ab conversion`, {
      level: 'error',
      tags: {
        entityId,
        contentServerUrl,
        unityBuildTarget,
        unityExitCode: exitCode || 'unknown',
        version: abVersion,
        log: s3LogKey,
        date: new Date().toISOString()
      }
    })

    try {
      // and then replace the manifest
      await components.cdnS3
        .upload({
          Bucket: cdnBucket,
          Key: failedManifestFile,
          ContentType: 'application/json',
          Body: JSON.stringify({
            entityId,
            contentServerUrl,
            version: abVersion,
            log: s3LogKey,
            date: new Date().toISOString()
          }),
          CacheControl: 'max-age=3600,s-maxage=3600',
          ACL: 'public-read'
        })
        .promise()
    } catch {}

    setTimeout(() => {
      // kill the process in one minute, enough time to allow prometheus to collect the metrics
      process.exit(199)
    }, 60_000)

    throw err
  } finally {
    if ($LOGS_BUCKET && hasContentChanged) {
      const log = `https://${$LOGS_BUCKET}.s3.amazonaws.com/${s3LogKey}`

      logger.info(`LogFile=${log}`, defaultLoggerMetadata)
      await components.cdnS3
        .upload({
          Bucket: $LOGS_BUCKET,
          Key: s3LogKey,
          Body: await promises.readFile(logFile),
          ACL: 'public-read'
        })
        .promise()
    } else {
      logger.info(`!!!!!!!! Log file not deleted or uploaded ${logFile}`, defaultLoggerMetadata)
    }

    await withPhaseTimer(
      components.metrics,
      'ab_converter_phase_cleanup_seconds',
      { build_target: $BUILD_TARGET, ab_version: abVersion },
      async () => {
        // delete output files
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
        // delete library folder
        try {
          await rimraf(`${$PROJECT_PATH}/Library`, { maxRetries: 3 })
        } catch (err: any) {
          logger.error(`Error deleting library folder: ${err}`, defaultLoggerMetadata)
        }
        //delete _Download folder
        try {
          await rimraf(`${$PROJECT_PATH}/Assets/_Downloaded`, { maxRetries: 3 })
        } catch (err: any) {
          logger.error(err, defaultLoggerMetadata)
        }

        // delete scene manifest folder
        await deleteSceneManifestFolder($PROJECT_PATH, logger, defaultLoggerMetadata)
      }
    )
  }

  logger.debug('Conversion finished', defaultLoggerMetadata)
  logger.debug(`Full project size ${getFolderSize($PROJECT_PATH)}`)
  printFolderSizes($PROJECT_PATH, logger)
}

async function deleteSceneManifestFolder(projectPath: string, logger: any, defaultLoggerMetadata: any): Promise<void> {
  const sceneManifestPath = `${projectPath}/Assets/_SceneManifest`
  logger.info(`Attempting to delete scene manifest folder: ${sceneManifestPath}`, defaultLoggerMetadata)
  try {
    await rimraf(sceneManifestPath, { maxRetries: 3 })
    const folderStillExists = fs.existsSync(sceneManifestPath)
    if (folderStillExists) {
      logger.warn(`Scene manifest folder still exists after deletion: ${sceneManifestPath}`, defaultLoggerMetadata)
    } else {
      logger.info(`Scene manifest folder successfully deleted: ${sceneManifestPath}`, defaultLoggerMetadata)
    }
  } catch (err: any) {
    logger.error(`Error deleting scene manifest folder ${sceneManifestPath}:`, {
      ...defaultLoggerMetadata,
      error: err
    })
    const folderStillExists = fs.existsSync(sceneManifestPath)
    logger.warn(`Scene manifest folder exists after failed deletion: ${folderStillExists}`, defaultLoggerMetadata)
  }
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
