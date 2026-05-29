import type { AppComponents } from '../../types'
import { EncoderError } from '../../adapters/asset-bundle-encoder'
import { parseBooleanFlag } from '../conversion-task'
import type { ISceneConverterComponent, SceneConvertOptions, SceneConvertResult } from './types'

/**
 * Builds the scene-converter logic component. Reads its two routing
 * flags (`ENCODER_ENABLED`, `ENCODER_FALLBACK_TO_UNITY`) at construction
 * time so per-message dispatch is a cheap conditional, not a config
 * round-trip.
 *
 * Rollout shape (per CLAUDE.md / the architecture discussion):
 *  1. Deploy with ENCODER_ENABLED=false on every pod. No behavior
 *     change; encoder code is in tree but inert.
 *  2. Flip ENCODER_ENABLED=true + ENCODER_FALLBACK_TO_UNITY=true on
 *     one Windows pod. Watch encoder_errors / engine_used metrics.
 *  3. Expand to the full Windows pool, then Mac, then WebGL.
 *  4. Once encoder reliability is steady, flip
 *     ENCODER_FALLBACK_TO_UNITY=false per pool. DLQ becomes the
 *     safety net for the rare encoder bug.
 *  5. Eventually remove the Unity runner adapter entirely.
 */
export async function createSceneConverter(
  components: Pick<AppComponents, 'config' | 'logs' | 'metrics' | 'unityRunner' | 'assetBundleEncoder' | 'sentry'>
): Promise<ISceneConverterComponent> {
  const { config, logs, metrics, unityRunner, assetBundleEncoder, sentry } = components
  const logger = logs.getLogger('scene-converter')

  const encoderEnabled = parseBooleanFlag(await config.getString('ENCODER_ENABLED'), false, (raw) =>
    logger.warn(
      `Unrecognized value for ENCODER_ENABLED: "${raw}" — falling back to the default (false). Accepted values: true/false/1/0/yes/no/on/off.`
    )
  )
  const encoderFallback = parseBooleanFlag(await config.getString('ENCODER_FALLBACK_TO_UNITY'), true, (raw) =>
    logger.warn(`Unrecognized value for ENCODER_FALLBACK_TO_UNITY: "${raw}" — falling back to the default (true).`)
  )
  const buildTarget = await config.requireString('BUILD_TARGET')
  const abVersion = await config.requireString('AB_VERSION')

  logger.info('Scene converter initialised', {
    encoderEnabled: String(encoderEnabled),
    encoderFallback: String(encoderFallback),
    buildTarget,
    abVersion
  } as any)

  async function convert(options: SceneConvertOptions): Promise<SceneConvertResult> {
    // Unity path — selected when the encoder is disabled OR when the
    // caller didn't provide the encoder's required inputs (defensive
    // guard for code paths that haven't been updated to thread the new
    // fields through, e.g. test-conversion.ts).
    if (!encoderEnabled) {
      return runUnity(options, 'unity')
    }

    const target = options.unityBuildTarget.toLowerCase()
    const encoderTarget = mapUnityTargetToEncoderTarget(target)
    if (!encoderTarget) {
      logger.warn('Encoder enabled but BUILD_TARGET not encoder-supported, using Unity', {
        unityBuildTarget: options.unityBuildTarget
      } as any)
      metrics.increment('ab_converter_engine_used_total', {
        engine: 'unity-unsupported-target'
      })
      return runUnity(options, 'unity')
    }

    if (!options.catalystBaseUrl || !options.contentMap) {
      logger.warn('Encoder enabled but caller did not supply catalystBaseUrl/contentMap, using Unity', {
        entityId: options.entityId
      } as any)
      metrics.increment('ab_converter_engine_used_total', { engine: 'unity-missing-inputs' })
      return runUnity(options, 'unity')
    }

    try {
      const result = await assetBundleEncoder.convert({
        outDirectory: options.outDirectory,
        entityId: options.entityId,
        buildTarget: encoderTarget,
        catalystBaseUrl: options.catalystBaseUrl,
        contentMap: options.contentMap,
        depsDigestByHash: options.depsDigestByHash ?? new Map(),
        cachedHashes: options.cachedHashes ?? [],
        skippedHashes: options.skippedHashes ?? [],
        shaderType: options.shaderType ?? 'dcl',
        failureTolerance: 0.05
      })

      metrics.increment('ab_converter_engine_used_total', { engine: 'encoder' })
      return {
        engine: 'encoder',
        exitCode: 0,
        partialFailures: result.partialFailures.length
      }
    } catch (err: unknown) {
      const code = err instanceof EncoderError ? err.code : 'UNKNOWN'
      metrics.increment('ab_converter_encoder_errors_total', {
        build_target: buildTarget,
        code
      })

      // Misconfiguration codes shouldn't fall back — Unity won't help.
      const isMisconfig = code === 'TARGET_MISMATCH' || code === 'INVALID_BAKE' || code === 'NOT_STARTED'
      if (isMisconfig || !encoderFallback) {
        sentry.captureException?.(err, {
          tags: { engine: 'encoder', entityId: options.entityId, ab_version: abVersion, code }
        })
        throw err
      }

      logger.warn('Encoder failed, falling back to Unity', {
        entityId: options.entityId,
        code,
        message: err instanceof Error ? err.message : String(err)
      } as any)
      sentry.captureException?.(err, {
        tags: {
          engine: 'encoder',
          entityId: options.entityId,
          ab_version: abVersion,
          code,
          fallback: 'true'
        }
      })
      return runUnity(options, 'encoder-fallback-unity')
    }
  }

  async function runUnity(
    options: SceneConvertOptions,
    engineLabel: 'unity' | 'encoder-fallback-unity'
  ): Promise<SceneConvertResult> {
    const exitCode = await unityRunner.runConversion({
      contentServerUrl: options.contentServerUrl,
      entityId: options.entityId,
      entityType: options.entityType,
      logFile: options.logFile,
      outDirectory: options.outDirectory,
      projectPath: options.projectPath,
      unityPath: options.unityPath,
      timeout: options.timeout,
      unityBuildTarget: options.unityBuildTarget,
      animation: options.animation,
      doISS: options.doISS,
      cachedHashes: options.cachedHashes,
      skippedHashes: options.skippedHashes,
      depsDigestByHash: options.depsDigestByHash
    })
    metrics.increment('ab_converter_engine_used_total', { engine: engineLabel })
    return { engine: engineLabel, exitCode }
  }

  return { convert }
}

/**
 * Translate Unity-style build-target strings ("StandaloneWindows64",
 * "StandaloneOSX", "WebGL") into the encoder's compact target enum.
 *
 * Returns undefined for targets the encoder doesn't support — currently
 * only Linux (which Unity supports but the encoder doesn't yet bake
 * shader manifests for).
 */
function mapUnityTargetToEncoderTarget(unityTarget: string): 'windows' | 'mac' | 'webgl' | undefined {
  switch (unityTarget) {
    case 'standalonewindows64':
      return 'windows'
    case 'standaloneosx':
      return 'mac'
    case 'webgl':
      return 'webgl'
    default:
      return undefined
  }
}
