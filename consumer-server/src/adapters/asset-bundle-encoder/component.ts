import { promises as fs } from 'fs'
import { join } from 'path'
import type { AppComponents } from '../../types'
import { parseBooleanFlag } from '../../logic/conversion-task'
import { BakeArtifactError, EncoderError } from './errors'
import type { EncoderConvertOptions, EncoderConvertResult, IAssetBundleEncoderComponent } from './types'

/**
 * Shape of the Rust napi-rs module. We require it lazily inside `start()`
 * rather than importing at the top so a missing prebuild on a dev machine
 * doesn't break TypeScript compilation of unrelated code paths. The shape
 * mirrors the `#[napi]` exports in `encoder/src/lib.rs` exactly.
 */
type NativeEncoderModule = {
  createEncoder(config: {
    buildTarget: string
    abVersion: string
    bakeArtifacts: {
      typeTrees: Buffer
      shaderManifestJson: Buffer
      bakeInfoJson: Buffer
    }
    maxConcurrentFetches?: number
    perSceneFetchConcurrency?: number
  }): Promise<NativeEncoderHandle>
}

type NativeEncoderHandle = {
  buildTarget(): string
  encode(input: {
    entityId: string
    entityType?: string
    shaderType: 'dcl' | 'gltfast'
    catalystBaseUrl: string
    contentMap: ReadonlyArray<{ file: string; hash: string }>
    depsDigestByHash: Record<string, string>
    cachedHashes: ReadonlyArray<string>
    skippedHashes: ReadonlyArray<string>
    failureTolerance: number
  }): Promise<{
    bundles: Array<{
      sourceHash: string
      bundleName: string
      dependencies: string[]
      uncompressedBytes: Buffer
    }>
    partialFailures: Array<{ hash: string; reason: string; message: string }>
    stats: {
      totalGltf: number
      encodedGltf: number
      totalTextures: number
      encodedTextures: number
      cachedSkipped: number
      brokenSkipped: number
      encodeWallMs: number
    }
    logs: Array<{ level: string; message: string }>
  }>
  // Scene-LOD source FBX → UnityFS LOD bundle. Requires the native module to be
  // built with the `fbx` feature (else it throws).
  encodeLod(fbxBytes: Buffer, entityId: string, level: number): Buffer
}

/**
 * Component factory. Loads bake artifacts from the configured S3 bake
 * bucket at `start()`, constructs the native encoder, and exposes a
 * single `convert()` method that mirrors the Unity-runner's per-scene
 * interface (modulo the encoder-specific fields).
 *
 * Lifecycle:
 *   start() — fetch bake artifacts, parse, hand to Rust. Failure to
 *             load any artifact crashes the pod so ops sees the
 *             misconfiguration immediately. No lazy retry — a wedged
 *             bake bucket should not silently leave the encoder
 *             half-initialised.
 *   convert() — per-scene work. Stateless beyond the bake artifacts;
 *               concurrent calls are safe (the Rust encoder uses a
 *               &self method and gates fetch concurrency internally).
 *   stop() — drops the native handle so the Rust-side Arc<EncoderInner>
 *            releases its memory on the next GC.
 */
export async function createAssetBundleEncoderComponent(
  components: Pick<AppComponents, 'config' | 'logs' | 'metrics' | 'cdnS3'>
): Promise<IAssetBundleEncoderComponent> {
  const { config, logs, metrics, cdnS3 } = components
  const logger = logs.getLogger('asset-bundle-encoder')

  // Read the kill switch up front. When the encoder is disabled, we return
  // a no-op shell that throws NOT_STARTED if anyone calls convert(). This
  // keeps the component cheap to construct in environments that don't run
  // the encoder (tests, pods that haven't been flipped over yet) — no S3
  // round-trip on start(), no native module load, no BAKE_VERSION
  // requirement.
  const encoderEnabled = parseBooleanFlag(await config.getString('ENCODER_ENABLED'), false)
  if (!encoderEnabled) {
    return {
      start: async () => {
        logger.info('Encoder disabled (ENCODER_ENABLED=false) — skipping bake artifact load')
      },
      stop: async () => {},
      convert: async () => {
        throw new EncoderError(
          'Encoder disabled — scene-converter should have routed to Unity. This is a wiring bug.',
          { code: 'NOT_STARTED' }
        )
      },
      encodeLod: () => {
        // LODs need the native module, which only loads when ENCODER_ENABLED=true.
        throw new EncoderError(
          'Encoder disabled (ENCODER_ENABLED=false) — encoder LODs require the native module.',
          { code: 'NOT_STARTED' }
        )
      }
    }
  }

  const buildTarget = (await config.requireString('BUILD_TARGET')) as 'windows' | 'mac' | 'webgl'
  const abVersion = await config.requireString('AB_VERSION')
  const bakeVersion = await config.requireString('BAKE_VERSION')
  const bakeBucket = await config.requireString('AB_BAKE_BUCKET')

  // Optional tuning knobs. The Rust side applies its own defaults (64 / 16)
  // when these are unset.
  const maxConcurrentFetches = parseOptionalNumber(await config.getString('ENCODER_FETCH_CONCURRENCY'))
  const perSceneFetchConcurrency = parseOptionalNumber(await config.getString('ENCODER_PER_SCENE_FETCH_CONCURRENCY'))

  let native: NativeEncoderHandle | undefined

  async function start(): Promise<void> {
    let nativeModule: NativeEncoderModule
    try {
      // Lazy require so missing prebuilds don't break TS compilation on
      // machines where the Rust crate isn't built.
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      nativeModule = require('@dcl/asset-bundle-encoder') as NativeEncoderModule
    } catch (err: any) {
      throw new BakeArtifactError(
        `Failed to load native encoder module — run \`yarn build\` in encoder/ first. Cause: ${err.message}`
      )
    }

    logger.info('Loading bake artifacts', { bakeVersion, buildTarget })

    const prefix = `${bakeVersion}/${buildTarget}`
    let typeTrees: Buffer
    let shaderManifestJson: Buffer
    let bakeInfoJson: Buffer
    try {
      ;[typeTrees, shaderManifestJson, bakeInfoJson] = await Promise.all([
        fetchBakeArtifact(cdnS3, bakeBucket, `${prefix}/typetrees.bin`),
        fetchBakeArtifact(cdnS3, bakeBucket, `${prefix}/shader-guids.json`),
        fetchBakeArtifact(cdnS3, bakeBucket, `${prefix}/bake-info.json`)
      ])
    } catch (err: any) {
      throw new BakeArtifactError(`Failed to load bake artifacts from s3://${bakeBucket}/${prefix}/: ${err.message}`)
    }

    native = await nativeModule.createEncoder({
      buildTarget,
      abVersion,
      bakeArtifacts: {
        typeTrees,
        shaderManifestJson,
        bakeInfoJson
      },
      maxConcurrentFetches,
      perSceneFetchConcurrency
    })

    const reportedTarget = native.buildTarget()
    if (reportedTarget !== buildTarget) {
      // Defensive — native target should match what we asked for. If the
      // bake artifacts were generated for a different target, the Rust
      // side accepted them but is misaligned with our pod's BUILD_TARGET.
      throw new BakeArtifactError(
        `Encoder reports target '${reportedTarget}' but pod is configured for '${buildTarget}'. Wrong bake bundle?`
      )
    }

    logger.info('Encoder ready', { abVersion, bakeVersion, buildTarget })
  }

  async function stop(): Promise<void> {
    // Drop the handle — Rust-side Arc releases when no encode() call is
    // still holding a clone. No explicit Rust-side stop needed; the
    // reqwest client and semaphores are owned by SceneEncoderInner.
    native = undefined
  }

  async function convert(options: EncoderConvertOptions): Promise<EncoderConvertResult> {
    if (!native) {
      throw new EncoderError('Encoder not started', { code: 'NOT_STARTED' })
    }
    if (options.buildTarget !== buildTarget) {
      throw new EncoderError('Build target mismatch', {
        code: 'TARGET_MISMATCH',
        context: { configured: buildTarget, requested: options.buildTarget }
      })
    }

    const startMs = Date.now()

    let result: Awaited<ReturnType<NativeEncoderHandle['encode']>>
    try {
      result = await native.encode({
        entityId: options.entityId,
        entityType: options.entityType,
        shaderType: options.shaderType,
        catalystBaseUrl: options.catalystBaseUrl,
        contentMap: options.contentMap,
        // napi-rs HashMap takes a plain object; convert at the boundary.
        depsDigestByHash: Object.fromEntries(options.depsDigestByHash),
        cachedHashes: [...options.cachedHashes],
        skippedHashes: [...options.skippedHashes],
        failureTolerance: options.failureTolerance
      })
    } catch (err: unknown) {
      // Translate native errors into typed EncoderError so the
      // scene-converter can branch on `.code` without re-parsing strings.
      throw EncoderError.fromNative(err)
    }

    // Push native logs into the wkc logger so a single conversion's
    // encoder activity is correlated to its consumer-server log line.
    for (const entry of result.logs) {
      const fn = pickLogFn(logger, entry.level)
      fn(entry.message, { entityId: options.entityId } as any)
    }

    // Write bundle bytes to outDirectory so the rest of conversion-task.ts
    // (readdir → manifest builder → uploadDir) keeps working unchanged.
    // Same on-disk shape Unity produces, minus the .manifest sidecars
    // (which Unity itself deletes — see Utils.cs:557 in the converter).
    await fs.mkdir(options.outDirectory, { recursive: true })
    const written: string[] = []
    for (const bundle of result.bundles) {
      const path = join(options.outDirectory, bundle.bundleName)
      await fs.writeFile(path, bundle.uncompressedBytes)
      written.push(bundle.bundleName)
    }

    // Per-conversion metrics. Build-target + ab-version labelling matches
    // existing ab_converter_* counters so dashboards can compare side by
    // side across the rollout.
    const labels = { build_target: buildTarget, ab_version: abVersion }
    metrics.observe('ab_converter_encoder_wall_seconds', labels, (Date.now() - startMs) / 1000)
    if (result.partialFailures.length > 0) {
      metrics.increment('ab_converter_encoder_partial_failures_total', labels, result.partialFailures.length)
    }

    return {
      writtenBundles: written,
      partialFailures: result.partialFailures,
      stats: result.stats
    }
  }

  // Encode one scene-LOD source FBX → UnityFS LOD bundle bytes. CPU-only (the
  // caller fetches the FBX + writes/uploads). Native errors → typed EncoderError.
  function encodeLod(fbxBytes: Buffer, entityId: string, level: number): Buffer {
    if (!native) {
      throw new EncoderError('Encoder not started', { code: 'NOT_STARTED' })
    }
    try {
      return native.encodeLod(fbxBytes, entityId, level)
    } catch (err: unknown) {
      throw EncoderError.fromNative(err)
    }
  }

  return { start, stop, convert, encodeLod }
}

/**
 * S3 getObject → Buffer, with a stable error message that surfaces the
 * key path (caller wraps in BakeArtifactError).
 */
async function fetchBakeArtifact(
  cdnS3: { getObject: (params: { Bucket: string; Key: string }) => { promise(): Promise<{ Body?: any }> } },
  bucket: string,
  key: string
): Promise<Buffer> {
  const res = await cdnS3.getObject({ Bucket: bucket, Key: key }).promise()
  if (!res.Body) {
    throw new Error(`empty body for s3://${bucket}/${key}`)
  }
  if (Buffer.isBuffer(res.Body)) return res.Body
  if (res.Body instanceof Uint8Array) return Buffer.from(res.Body)
  if (typeof res.Body === 'string') return Buffer.from(res.Body, 'utf8')
  throw new Error(`unexpected Body type for s3://${bucket}/${key}`)
}

function parseOptionalNumber(raw: string | undefined): number | undefined {
  if (raw === undefined || raw === '') return undefined
  const n = Number(raw)
  return Number.isFinite(n) && n > 0 ? n : undefined
}

type LogFn = (message: string, extra?: Record<string, string | number>) => void

function pickLogFn(logger: { info: LogFn; warn: LogFn; error: LogFn; debug: LogFn }, level: string): LogFn {
  switch (level) {
    case 'error':
      return logger.error.bind(logger)
    case 'warn':
      return logger.warn.bind(logger)
    case 'debug':
      return logger.debug.bind(logger)
    default:
      return logger.info.bind(logger)
  }
}
