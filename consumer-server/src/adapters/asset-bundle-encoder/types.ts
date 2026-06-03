import type { IBaseComponent } from '@well-known-components/interfaces'

/**
 * Options for a single scene encode call. Shape parallels the Unity-runner
 * `RunConversionOptions` but trims the Unity-specific fields (logFile,
 * projectPath, unityPath, animation, doISS) — the encoder doesn't spawn a
 * subprocess, doesn't write a Unity log file, and doesn't support the
 * legacy ISS flow.
 *
 * The encoder is responsible for fetching every byte it needs from the
 * catalyst at `catalystBaseUrl`. consumer-server passes URLs and metadata,
 * never raw asset bytes — keeps the napi-rs boundary cheap regardless of
 * scene size.
 */
export type EncoderConvertOptions = {
  /** Directory where bundle files are written. Created if missing. Same
   * outDirectory semantics the Unity-runner uses, so downstream code
   * (uploadDir, manifest readdir) is engine-agnostic. */
  outDirectory: string

  entityId: string

  /** Entity DTO type ("scene" | "emote" | "wearable" | …). Drives the
   * encoder's animation method (emote → Mecanim Animator/AnimatorController,
   * wearable → none, else legacy Animation), mirroring Unity's
   * GetAnimationMethod. Optional — absent is treated as a plain scene. */
  entityType?: string

  /** Must match the pod's BUILD_TARGET. Mismatches are rejected with
   * TARGET_MISMATCH rather than silently re-encoding for the wrong
   * platform. */
  buildTarget: 'windows' | 'mac' | 'webgl'

  /** Trailing-slashed catalyst contents URL (e.g.,
   * "https://peer.decentraland.org/content/contents/"). Consumer-server
   * normalises via `normalizeContentsBaseUrl` before passing in. */
  catalystBaseUrl: string

  /** Entity content list — `{ lowercased filename, CID }` pairs as the
   * catalyst returned them. Encoder uses this to (a) decide what to
   * fetch and (b) resolve glb `images[].uri` references to texture
   * hashes during encoding. */
  contentMap: ReadonlyArray<{ file: string; hash: string }>

  /** Per-glb deps digests computed server-side by `computePerAssetDigests`.
   * The encoder writes glb bundle names as `{hash}_{digest}_{target}`;
   * a missing digest for an unskipped glb fails the whole encode with
   * MISSING_DEPS_DIGEST. */
  depsDigestByHash: ReadonlyMap<string, string>

  /** Hashes whose canonical bundle already exists upstream. Encoder
   * drops them from its work set (mirrors Unity's `-cachedHashes`). */
  cachedHashes: ReadonlyArray<string>

  /** Hashes flagged as unconvertible (broken glbs / metadata-only files).
   * Encoder drops them before any fetch attempt (mirrors Unity's
   * `-skippedHashes`). */
  skippedHashes: ReadonlyArray<string>

  /** Which shader the encoder writes into Material assets. `'dcl'`
   * resolves to "DCL/Scene" (production default); `'gltfast'` is
   * parity with the Unity converter's flag and not used today. */
  shaderType: 'dcl' | 'gltfast'

  /** 0.05 = tolerate up to 5% per-asset failures. Matches Unity's
   * `failingConversionTolerance` semantics — once exceeded, the whole
   * encode fails and the TS-side scene-converter decides whether to
   * fall back to Unity. */
  failureTolerance: number
}

export type EncoderConvertResult = {
  /** Filenames written to outDirectory (relative). Used by scene-converter
   * for the engine_used metric labels and the conversion-task.ts
   * manifest builder downstream. */
  writtenBundles: ReadonlyArray<string>

  /** Per-asset failures that were tolerated. Mirrors Unity's per-glb
   * skip behaviour but with a wider failure taxonomy because the
   * encoder owns asset fetching too. */
  partialFailures: ReadonlyArray<{
    hash: string
    reason: string
    message: string
  }>

  stats: {
    totalGltf: number
    encodedGltf: number
    totalTextures: number
    encodedTextures: number
    cachedSkipped: number
    brokenSkipped: number
    encodeWallMs: number
  }
}

/**
 * Adapter wrapping the Rust napi-rs encoder. Holds bake artifacts in
 * memory for the process lifetime (loaded once in `start()`), exposes
 * `convert()` for per-scene work.
 */
export type IAssetBundleEncoderComponent = IBaseComponent & {
  convert(options: EncoderConvertOptions): Promise<EncoderConvertResult>
  /** Encode one scene-LOD source FBX (`{entityId}_{level}.fbx` bytes) → UnityFS
   * LOD bundle bytes. Synchronous (CPU-only); the caller fetches the FBX and
   * writes/uploads. `parcels` are the scene's parcel pointers ("x,y") used for
   * the LOD material clipping planes (empty = no clipping). Throws an
   * `EncoderError` (e.g. `NOT_STARTED`, or when the native module lacks `fbx`). */
  encodeLod(fbxBytes: Buffer, entityId: string, level: number, parcels: string[]): Buffer
}
