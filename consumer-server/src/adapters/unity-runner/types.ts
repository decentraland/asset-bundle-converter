import type { IBaseComponent } from '@well-known-components/interfaces'

export type RunConversionOptions = {
  logFile: string
  outDirectory: string
  entityId: string
  entityType: string
  contentServerUrl: string
  unityPath: string
  projectPath: string
  timeout: number
  unityBuildTarget: string
  animation: string | undefined
  doISS: boolean | undefined
  cachedHashes?: string[]
  /**
   * Content hashes whose glb/gltf bytes the consumer-server determined are
   * unconvertible (missing dependencies / unparseable). Unity drops these
   * from `gltfPaths` and `bufferPaths` before any download or import
   * attempt, so no bundle is produced for them. Distinct from
   * `cachedHashes` which presumes the canonical bundle exists upstream.
   */
  skippedHashes?: string[]
  depsDigestByHash?: ReadonlyMap<string, string>
}

export type RunLodsConversionOptions = {
  logFile: string
  outDirectory: string
  entityId: string
  lods: string[]
  unityPath: string
  projectPath: string
  timeout: number
  unityBuildTarget: string
}

/**
 * Wrapper around the Unity child-process spawn used to convert scenes,
 * wearables, and LODs into asset bundles. Methods take per-invocation
 * options; the component itself owns the `unity-runner` logger and metric
 * emission (timeouts).
 *
 * Returns Unity's exit code (or -1 when the process exited without a code).
 * Throws on timeout or spawn error.
 */
export type IUnityRunnerComponent = IBaseComponent & {
  runConversion(options: RunConversionOptions): Promise<number>
  runLodsConversion(options: RunLodsConversionOptions): Promise<number>
}
