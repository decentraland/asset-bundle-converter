import { Entity } from '@dcl/schemas'
import { AssetCacheResult, SkippedAsset } from '../asset-reuse'

export type Manifest = {
  version: string
  files: string[]
  exitCode: number | null
  contentServerUrl?: string
  date: string
}

/**
 * Structured outcome of a scene-conversion probe. Each variant corresponds to a
 * branch point in the pre-Unity pipeline; the discriminated union lets each
 * caller map the outcome to its own return shape (triage's `TriagePassOutcome`
 * union vs. conversion's numeric exit code) without duplicating the probe logic.
 *
 * - `invalid-build-target`: `BUILD_TARGET` is not windows/mac.
 * - `already-converted`: existing manifest at the current AB version with
 *   exitCode 0. Caller returns 13.
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
 * - `cache-probe-failed`: digest pass succeeded but the cache probe threw.
 *   Caller proceeds to Unity (digests are still usable for canonical paths).
 * - `partial-hit`: at least one asset hash was missing canonical bytes. Caller
 *   proceeds to Unity with `cachedHashes` so Unity skips converting those.
 * - `full-hit`: every probed hash is canonical. Caller uploads the entity
 *   manifest + source files via `uploadFastPathResult` and returns success.
 */
export type ProbeOutcome =
  | { kind: 'invalid-build-target' }
  | { kind: 'already-converted' }
  | { kind: 'catalyst-unreachable'; error: Error }
  // `entity` is non-null here because the probe returns `catalyst-unreachable`
  // before reaching this branch when the fetch fails. `entityType` is the
  // fetched entity's `type` and may be anything that isn't 'scene' (or 'scene'
  // when the kill switch is off or doISS is true).
  | { kind: 'no-asset-reuse'; entity: Entity; entityType: string }
  | { kind: 'digest-failed'; error: Error }
  | {
      kind: 'cache-probe-skipped'
      entity: Entity
      depsDigestByHash: ReadonlyMap<string, string>
      skippedAssets: ReadonlyMap<string, SkippedAsset>
    }
  | {
      kind: 'cache-probe-failed'
      entity: Entity
      depsDigestByHash: ReadonlyMap<string, string>
      skippedAssets: ReadonlyMap<string, SkippedAsset>
      error: Error
    }
  | {
      kind: 'partial-hit'
      entity: Entity
      cacheResult: AssetCacheResult
      depsDigestByHash: ReadonlyMap<string, string>
      skippedAssets: ReadonlyMap<string, SkippedAsset>
    }
  | {
      kind: 'full-hit'
      entity: Entity
      cacheResult: AssetCacheResult
      depsDigestByHash: ReadonlyMap<string, string>
      skippedAssets: ReadonlyMap<string, SkippedAsset>
    }

export type ProbeArgs = {
  entityId: string
  contentServerUrl: string
  abVersion: string
  buildTarget: string
  force: boolean
  /** The caller's `ASSET_REUSE_ENABLED` kill switch. */
  assetReuseEnabled: boolean
  /** Whether the job is a legacy v2004 (ISS) job. Such jobs always need Unity, so the probe short-circuits to `no-asset-reuse`. */
  doISS: boolean
  /** Tag applied to the Sentry event on digest failure. Defaults to `per-asset-digest`. */
  sentryPhase?: string
}

export type UploadFastPathArgs = {
  entity: Entity
  contentServerUrl: string
  cdnBucket: string
  manifestFile: string
  entityScopedUploadPath: string
  abVersion: string
  cacheResult: AssetCacheResult
}

/**
 * Single component for the scene pre-Unity pipeline. Consolidates what was
 * previously split across `logic/probe-scene.ts` and the function exports of
 * `logic/asset-reuse.ts` into one public surface, so callers depend on one
 * thing instead of importing six free functions across two modules.
 *
 * Interface exposes only methods that have external callers. `checkAssetCache`
 * and `computePerAssetDigests` are reachable as free functions from
 * `asset-reuse.ts` for tests and the migration script; inside this component
 * they're internal helpers used by `probe()` and aren't part of the public
 * surface.
 *
 * Implementation note: methods delegate to the existing free-function bodies
 * in `asset-reuse.ts` (kept in place so its 1500-line unit test suite stays
 * stable). This component is the supported entry point for production code;
 * the underlying modules are implementation details that future refactors
 * are free to reorganise.
 */
export interface IScenesComponent {
  probe(args: ProbeArgs): Promise<ProbeOutcome>
  uploadFastPathResult(args: UploadFastPathArgs): Promise<void>
  purgeCachedBundlesFromOutput(outDirectory: string, cachedHashes: string[]): Promise<number>
  getCdnBucket(): Promise<string>
  manifestKeyForEntity(entityId: string, target: string | undefined): string
  uploadEntityManifest(cdnBucket: string, key: string, manifest: Manifest): Promise<void>
  uploadSceneSourceFilesToCDN(
    entity: Entity,
    contentServerUrl: string,
    uploadPath: string,
    cdnBucket: string
  ): Promise<void>
}
