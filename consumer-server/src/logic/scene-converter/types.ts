import type { RunConversionOptions } from '../../adapters/unity-runner'

/**
 * Options for one scene/wearable/emote conversion. Superset of the
 * Unity-runner's `RunConversionOptions` — the encoder-only fields
 * (catalystBaseUrl, contentMap, shaderType) are optional so the legacy
 * Unity path can omit them without TS complaints.
 *
 * NOTE: LOD conversion is NOT routed through here. `executeLODConversion`
 * in conversion-task.ts continues to call `components.unityRunner.runLodsConversion`
 * directly. The encoder doesn't implement LOD support in v1.
 */
export type SceneConvertOptions = RunConversionOptions & {
  /** Trailing-slashed catalyst contents URL. Required when the encoder
   * path is selected; ignored on the Unity path (Unity reads it via
   * RunConversionOptions.contentServerUrl). */
  catalystBaseUrl?: string

  /** Entity content list — the catalyst's `{ file, hash }` pairs.
   * Required for the encoder path. */
  contentMap?: ReadonlyArray<{ file: string; hash: string }>

  /** Which shader to bind in encoder-produced materials. Defaults to
   * 'dcl' (the production converter's default). */
  shaderType?: 'dcl' | 'gltfast'
}

export type SceneConvertResult = {
  /** Which engine actually executed. Visible to callers for logging /
   * metric correlation. `'encoder-fallback-unity'` indicates the encoder
   * was attempted and failed, then Unity ran successfully. */
  engine: 'unity' | 'encoder' | 'encoder-fallback-unity'

  /** Unity exit code on the Unity / encoder-fallback path, or 0 on a
   * successful encoder run (the encoder doesn't model exit codes —
   * non-zero == thrown error == fallback or rethrow). */
  exitCode: number

  /** Number of partial failures the encoder tolerated, if the encoder
   * ran. undefined on Unity-only paths. */
  partialFailures?: number
}

export type ISceneConverterComponent = {
  /**
   * Convert a scene, wearable, or emote into asset bundles. Routes
   * between the Unity runner and the Rust encoder based on
   * ENCODER_ENABLED; respects ENCODER_FALLBACK_TO_UNITY for rollout
   * safety.
   *
   * Produces bundle files in `options.outDirectory` regardless of
   * engine, so downstream code (manifest building, S3 upload) is
   * engine-agnostic.
   *
   * Does NOT cover LOD conversion — call
   * `components.unityRunner.runLodsConversion` directly for those.
   */
  convert(options: SceneConvertOptions): Promise<SceneConvertResult>
}
