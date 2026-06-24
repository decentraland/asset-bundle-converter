// Unit coverage for the scenes component. The integration tests at
// test/integration/execute-conversion.spec.ts and
// test/integration/execute-triage-pass.spec.ts exercise the component
// transitively through executeConversion / executeTriagePass against
// mock-aws-s3; this file targets each public method directly with stubbed
// dependencies so the per-method dispatch logic (especially the nine
// ProbeOutcome variants) is covered at the unit level.

import { createConfigComponent } from '@well-known-components/env-config-provider'
import { createLogComponent } from '@well-known-components/logger'
import { createMetricsComponent } from '@dcl/metrics'
import { metricDeclarations } from '../../src/metrics'
import { Entity } from '@dcl/schemas'

jest.mock('../../src/logic/asset-reuse', () => {
  const real = jest.requireActual('../../src/logic/asset-reuse')
  return {
    ...real,
    checkAssetCache: jest.fn(),
    computePerAssetDigests: jest.fn(),
    purgeCachedBundlesFromOutput: jest.fn()
  }
})

import {
  AssetCacheResult,
  checkAssetCache,
  computePerAssetDigests,
  purgeCachedBundlesFromOutput
} from '../../src/logic/asset-reuse'
import { createScenesComponent, IScenesComponent, Manifest, ProbeArgs } from '../../src/logic/scenes'
import {
  createCatalystMock,
  createCdnS3Mock,
  createSentryMock,
  MockedCatalystComponent,
  MockedCdnS3,
  MockedSentryComponent
} from '../mocks'
import { createInMemoryCacheComponent } from '@dcl/memory-cache-component'

const mockedCheckAssetCache = checkAssetCache as jest.Mock
const mockedComputePerAssetDigests = computePerAssetDigests as jest.Mock
const mockedPurgeCachedBundlesFromOutput = purgeCachedBundlesFromOutput as jest.Mock

type Harness = {
  scenes: IScenesComponent
  cdnS3: MockedCdnS3
  sentry: MockedSentryComponent
  catalyst: MockedCatalystComponent
  originalFetch: typeof globalThis.fetch
  fetch: jest.Mock
}

async function buildHarness(overrides?: { cdnBucket?: string }): Promise<Harness> {
  const config = createConfigComponent({
    PLATFORM: 'windows',
    BUILD_TARGET: 'windows',
    AB_VERSION_WINDOWS: 'v48',
    AB_VERSION_MAC: 'v48',
    AB_VERSION: '',
    CDN_BUCKET: overrides?.cdnBucket ?? 'test-bucket'
  })
  const metrics = await createMetricsComponent(metricDeclarations, { config })
  const logs = await createLogComponent({ metrics })

  const cdnS3 = createCdnS3Mock()
  const sentry = createSentryMock()
  const catalyst = createCatalystMock()

  // The scenes component reads CDN_BUCKET once at construction, so
  // `overrides.cdnBucket` is locked in here for the lifetime of the harness.
  const scenes = await createScenesComponent({
    logs,
    config,
    metrics,
    cdnS3: cdnS3 as any,
    sentry,
    catalyst,
    redis: createInMemoryCacheComponent()
  })

  const originalFetch = globalThis.fetch
  const fetch = jest.fn() as unknown as jest.Mock
  globalThis.fetch = fetch as any

  return { scenes, cdnS3, sentry, catalyst, originalFetch, fetch }
}

function buildSceneEntity(overrides?: Partial<Entity>): Entity {
  return {
    id: 'bafy-scene-id',
    version: 'v3',
    type: 'scene',
    pointers: ['0,0'],
    timestamp: 1234567890,
    content: [
      { file: 'main.crdt', hash: 'h-main-crdt' },
      { file: 'scene.json', hash: 'h-scene-json' },
      { file: 'bin/index.js', hash: 'h-index-js' }
    ],
    metadata: { main: 'bin/index.js' },
    ...overrides
  } as Entity
}

function buildProbeArgs(overrides?: Partial<ProbeArgs>): ProbeArgs {
  return {
    entityId: 'bafy-scene-id',
    contentServerUrl: 'https://peer.decentraland.org/content',
    abVersion: 'v48',
    buildTarget: 'windows',
    force: false,
    assetReuseEnabled: true,
    doISS: false,
    ...overrides
  }
}

function buildAssetCacheResult(overrides?: Partial<AssetCacheResult>): AssetCacheResult {
  return {
    cachedHashes: [],
    missingHashes: [],
    unitySkippableHashes: [],
    canonicalNameByHash: {},
    depsDigestByHash: new Map(),
    metadataOnlyHashes: new Set<string>(),
    ...overrides
  }
}

function fetchResponse(buf: Buffer, ok: boolean = true): any {
  return {
    ok,
    status: ok ? 200 : 500,
    statusText: ok ? 'OK' : 'Error',
    headers: { get: (name: string) => (name.toLowerCase() === 'content-length' ? String(buf.length) : null) },
    arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)
  }
}

describe('when createScenesComponent is invoked with the standard dependencies', () => {
  let harness: Harness

  beforeEach(async () => {
    harness = await buildHarness()
  })

  afterEach(() => {
    globalThis.fetch = harness.originalFetch
    jest.clearAllMocks()
  })

  it('should return a component that exposes the full public surface', () => {
    expect(typeof harness.scenes.probe).toBe('function')
    expect(typeof harness.scenes.uploadFastPathResult).toBe('function')
    expect(typeof harness.scenes.purgeCachedBundlesFromOutput).toBe('function')
    expect(typeof harness.scenes.getCdnBucket).toBe('function')
    expect(typeof harness.scenes.manifestKeyForEntity).toBe('function')
    expect(typeof harness.scenes.uploadEntityManifest).toBe('function')
    expect(typeof harness.scenes.uploadSceneSourceFilesToCDN).toBe('function')
  })
})

describe('when getCdnBucket is called', () => {
  describe('and CDN_BUCKET is configured', () => {
    let harness: Harness

    beforeEach(async () => {
      harness = await buildHarness({ cdnBucket: 'configured-bucket' })
    })

    afterEach(() => {
      globalThis.fetch = harness.originalFetch
      jest.clearAllMocks()
    })

    it('should return the configured bucket name from construction-time capture', async () => {
      await expect(harness.scenes.getCdnBucket()).resolves.toBe('configured-bucket')
    })
  })

  describe('and CDN_BUCKET is missing from config', () => {
    let scenes: IScenesComponent

    beforeEach(async () => {
      const config = createConfigComponent({
        PLATFORM: 'windows',
        BUILD_TARGET: 'windows',
        AB_VERSION_WINDOWS: 'v48',
        AB_VERSION_MAC: 'v48',
        AB_VERSION: ''
        // CDN_BUCKET intentionally unset
      })
      const metrics = await createMetricsComponent(metricDeclarations, { config })
      const logs = await createLogComponent({ metrics })
      scenes = await createScenesComponent({
        logs,
        config,
        metrics,
        cdnS3: {} as any,
        sentry: {} as any,
        catalyst: {} as any,
        redis: createInMemoryCacheComponent()
      })
    })

    afterEach(() => {
      jest.clearAllMocks()
    })

    it('should fall back to the literal "CDN_BUCKET" placeholder', async () => {
      await expect(scenes.getCdnBucket()).resolves.toBe('CDN_BUCKET')
    })
  })
})

describe('when manifestKeyForEntity is called', () => {
  let harness: Harness

  beforeEach(async () => {
    harness = await buildHarness()
  })

  afterEach(() => {
    globalThis.fetch = harness.originalFetch
    jest.clearAllMocks()
  })

  describe('and the target is webgl (now treated like any other target)', () => {
    it('should append the webgl suffix since webgl no longer receives special-case handling', () => {
      expect(harness.scenes.manifestKeyForEntity('bafy-1', 'webgl')).toBe('manifest/bafy-1_webgl.json')
    })
  })

  describe('and the target is windows', () => {
    it('should append the build-target suffix', () => {
      expect(harness.scenes.manifestKeyForEntity('bafy-1', 'windows')).toBe('manifest/bafy-1_windows.json')
    })
  })

  describe('and the target is mac', () => {
    it('should append the build-target suffix', () => {
      expect(harness.scenes.manifestKeyForEntity('bafy-1', 'mac')).toBe('manifest/bafy-1_mac.json')
    })
  })

  describe('and the target is undefined', () => {
    it('should return the bare key (legacy fallback shape)', () => {
      expect(harness.scenes.manifestKeyForEntity('bafy-1', undefined)).toBe('manifest/bafy-1.json')
    })
  })
})

describe('when uploadEntityManifest is called', () => {
  let harness: Harness
  const manifest: Manifest = {
    version: 'v48',
    files: ['hash1_windows', 'hash2_windows'],
    exitCode: 0,
    contentServerUrl: 'https://peer.decentraland.org/content',
    date: '2026-05-13T00:00:00.000Z'
  }

  beforeEach(async () => {
    harness = await buildHarness()
    await harness.scenes.uploadEntityManifest('test-bucket', 'manifest/bafy.json', manifest)
  })

  afterEach(() => {
    globalThis.fetch = harness.originalFetch
    jest.clearAllMocks()
  })

  it('should upload to the supplied bucket + key', () => {
    expect(harness.cdnS3.upload).toHaveBeenCalledWith(
      expect.objectContaining({
        Bucket: 'test-bucket',
        Key: 'manifest/bafy.json'
      })
    )
  })

  it('should set Cache-Control to the safety-critical no-cache value (clients must revalidate on every fetch)', () => {
    expect(harness.cdnS3.upload).toHaveBeenCalledWith(
      expect.objectContaining({ CacheControl: 'private, max-age=0, no-cache' })
    )
  })

  it('should set ContentType to application/json', () => {
    expect(harness.cdnS3.upload).toHaveBeenCalledWith(expect.objectContaining({ ContentType: 'application/json' }))
  })

  it('should JSON-encode the manifest body', () => {
    const call = harness.cdnS3.upload.mock.calls[0][0]
    expect(JSON.parse(call.Body)).toEqual(manifest)
  })
})

describe('when uploadSceneSourceFilesToCDN is called', () => {
  describe('and every source file is present in entity.content', () => {
    let harness: Harness
    let entity: Entity

    beforeEach(async () => {
      harness = await buildHarness()
      entity = buildSceneEntity()
      harness.fetch.mockResolvedValue(fetchResponse(Buffer.from('source-bytes')))
      await harness.scenes.uploadSceneSourceFilesToCDN(
        entity,
        'https://peer.decentraland.org/content',
        'v48/bafy-scene-id',
        'test-bucket'
      )
    })

    afterEach(() => {
      globalThis.fetch = harness.originalFetch
      jest.clearAllMocks()
    })

    it('should fetch main.crdt, scene.json, and the entity.metadata.main script (three round trips)', () => {
      expect(harness.fetch).toHaveBeenCalledTimes(3)
    })

    it('should upload main.crdt under the entity-scoped path', () => {
      expect(harness.cdnS3.upload).toHaveBeenCalledWith(
        expect.objectContaining({
          Key: 'v48/bafy-scene-id/main.crdt',
          ContentType: 'application/octet-stream'
        })
      )
    })

    it('should upload scene.json with application/json content-type', () => {
      expect(harness.cdnS3.upload).toHaveBeenCalledWith(
        expect.objectContaining({
          Key: 'v48/bafy-scene-id/scene.json',
          ContentType: 'application/json'
        })
      )
    })

    it('should upload the .js main script with application/javascript content-type', () => {
      expect(harness.cdnS3.upload).toHaveBeenCalledWith(
        expect.objectContaining({
          Key: 'v48/bafy-scene-id/bin/index.js',
          ContentType: 'application/javascript'
        })
      )
    })

    it('should set immutable Cache-Control on every source file (clients can long-cache)', () => {
      for (const call of harness.cdnS3.upload.mock.calls) {
        expect(call[0].CacheControl).toBe('public, max-age=31536000, immutable')
      }
    })
  })

  describe('and entity.metadata.main is missing', () => {
    let harness: Harness

    beforeEach(async () => {
      harness = await buildHarness()
      const entity = buildSceneEntity({ metadata: {} })
      harness.fetch.mockResolvedValue(fetchResponse(Buffer.from('source-bytes')))
      await harness.scenes.uploadSceneSourceFilesToCDN(
        entity,
        'https://peer.decentraland.org/content',
        'v48/bafy-scene-id',
        'test-bucket'
      )
    })

    afterEach(() => {
      globalThis.fetch = harness.originalFetch
      jest.clearAllMocks()
    })

    it('should upload only main.crdt and scene.json (no third script fetch)', () => {
      expect(harness.fetch).toHaveBeenCalledTimes(2)
    })
  })

  describe('and a declared source file is absent from entity.content', () => {
    let harness: Harness

    beforeEach(async () => {
      harness = await buildHarness()
      // Drop main.crdt from content; main script and scene.json remain.
      const entity = buildSceneEntity({
        content: [
          { file: 'scene.json', hash: 'h-scene-json' },
          { file: 'bin/index.js', hash: 'h-index-js' }
        ]
      })
      harness.fetch.mockResolvedValue(fetchResponse(Buffer.from('source-bytes')))
      await harness.scenes.uploadSceneSourceFilesToCDN(
        entity,
        'https://peer.decentraland.org/content',
        'v48/bafy-scene-id',
        'test-bucket'
      )
    })

    afterEach(() => {
      globalThis.fetch = harness.originalFetch
      jest.clearAllMocks()
    })

    it('should skip the missing file without throwing and upload the remaining two', () => {
      expect(harness.cdnS3.upload).toHaveBeenCalledTimes(2)
    })
  })

  describe('and the catalyst returns a non-2xx for one source file', () => {
    let harness: Harness

    beforeEach(async () => {
      harness = await buildHarness()
      const entity = buildSceneEntity()
      // First fetch (main.crdt) returns 500; the rest succeed.
      harness.fetch
        .mockResolvedValueOnce(fetchResponse(Buffer.from(''), false))
        .mockResolvedValue(fetchResponse(Buffer.from('source-bytes')))
      await harness.scenes.uploadSceneSourceFilesToCDN(
        entity,
        'https://peer.decentraland.org/content',
        'v48/bafy-scene-id',
        'test-bucket'
      )
    })

    afterEach(() => {
      globalThis.fetch = harness.originalFetch
      jest.clearAllMocks()
    })

    it('should not upload the failed file (the parallel sibling uploads still proceed)', () => {
      // Two of three sources fetched successfully → two uploads.
      expect(harness.cdnS3.upload).toHaveBeenCalledTimes(2)
    })
  })

  describe('and the S3 upload itself throws for one of the source files', () => {
    let harness: Harness
    let thrown: unknown

    beforeEach(async () => {
      harness = await buildHarness()
      const entity = buildSceneEntity()
      harness.fetch.mockResolvedValue(fetchResponse(Buffer.from('source-bytes')))
      // First upload rejects; siblings succeed.
      harness.cdnS3.upload
        .mockReturnValueOnce({
          promise: jest.fn(async () => {
            throw new Error('S3 PUT failure')
          })
        })
        .mockReturnValue({ promise: jest.fn(async () => ({})) })
      try {
        await harness.scenes.uploadSceneSourceFilesToCDN(
          entity,
          'https://peer.decentraland.org/content',
          'v48/bafy-scene-id',
          'test-bucket'
        )
      } catch (err) {
        thrown = err
      }
    })

    afterEach(() => {
      globalThis.fetch = harness.originalFetch
      jest.clearAllMocks()
    })

    it('should not propagate the upload error — the inner catch swallows it so siblings still run', () => {
      expect(thrown).toBeUndefined()
    })
  })
})

describe('when purgeCachedBundlesFromOutput is called', () => {
  let harness: Harness
  let result: number

  beforeEach(async () => {
    harness = await buildHarness()
    mockedPurgeCachedBundlesFromOutput.mockResolvedValueOnce(7)
    result = await harness.scenes.purgeCachedBundlesFromOutput('/tmp/out', ['hashA', 'hashB'])
  })

  afterEach(() => {
    globalThis.fetch = harness.originalFetch
    jest.clearAllMocks()
  })

  it('should delegate to the asset-reuse impl', () => {
    expect(mockedPurgeCachedBundlesFromOutput).toHaveBeenCalledWith('/tmp/out', ['hashA', 'hashB'], expect.anything())
  })

  it('should pass an internally-built logger so callers do not have to supply one', () => {
    const loggerArg = mockedPurgeCachedBundlesFromOutput.mock.calls[0][2]
    expect(loggerArg).toBeDefined()
    expect(typeof loggerArg.info).toBe('function')
  })

  it('should return the count produced by the impl', () => {
    expect(result).toBe(7)
  })
})

describe('when probe is called', () => {
  describe('and BUILD_TARGET is invalid', () => {
    let harness: Harness
    let outcome: Awaited<ReturnType<IScenesComponent['probe']>>

    beforeEach(async () => {
      harness = await buildHarness()
      outcome = await harness.scenes.probe(buildProbeArgs({ buildTarget: 'nintendo-switch' }))
    })

    afterEach(() => {
      globalThis.fetch = harness.originalFetch
      jest.clearAllMocks()
    })

    it('should short-circuit with invalid-build-target before any catalyst or S3 work', () => {
      expect(outcome.kind).toBe('invalid-build-target')
    })

    it('should not fetch the catalyst entity', () => {
      expect(harness.catalyst.getActiveEntity).not.toHaveBeenCalled()
    })
  })

  describe('and a matching manifest already exists for the current abVersion', () => {
    let harness: Harness
    let outcome: Awaited<ReturnType<IScenesComponent['probe']>>

    beforeEach(async () => {
      harness = await buildHarness()
      const priorManifest: Manifest = {
        version: 'v48',
        files: ['hash1_windows'],
        exitCode: 0,
        date: '2026-05-12T00:00:00.000Z'
      }
      harness.cdnS3.getObject.mockReturnValueOnce({
        promise: jest.fn(async () => ({ Body: Buffer.from(JSON.stringify(priorManifest)) }))
      })
      outcome = await harness.scenes.probe(buildProbeArgs())
    })

    afterEach(() => {
      globalThis.fetch = harness.originalFetch
      jest.clearAllMocks()
    })

    it('should short-circuit with already-converted', () => {
      expect(outcome.kind).toBe('already-converted')
    })

    it('should not fetch the catalyst entity (manifest check happens first)', () => {
      expect(harness.catalyst.getActiveEntity).not.toHaveBeenCalled()
    })
  })

  describe('and a prior manifest exists but the recorded version differs from abVersion', () => {
    let harness: Harness
    let outcome: Awaited<ReturnType<IScenesComponent['probe']>>

    beforeEach(async () => {
      harness = await buildHarness()
      const priorManifest: Manifest = {
        version: 'v47',
        files: ['hash1_windows'],
        exitCode: 0,
        date: '2026-04-12T00:00:00.000Z'
      }
      harness.cdnS3.getObject.mockReturnValueOnce({
        promise: jest.fn(async () => ({ Body: Buffer.from(JSON.stringify(priorManifest)) }))
      })
      harness.catalyst.getActiveEntity.mockResolvedValueOnce(buildSceneEntity())
      mockedComputePerAssetDigests.mockResolvedValueOnce({
        digests: new Map([['h-glb', 'digest-1']]),
        skipped: new Map()
      })
      mockedCheckAssetCache.mockResolvedValueOnce(buildAssetCacheResult({ cachedHashes: [], missingHashes: ['h-glb'] }))
      outcome = await harness.scenes.probe(buildProbeArgs({ abVersion: 'v48' }))
    })

    afterEach(() => {
      globalThis.fetch = harness.originalFetch
      jest.clearAllMocks()
    })

    it('should fall through past already-converted (version mismatch) and reach the probe pipeline', () => {
      expect(outcome.kind).toBe('partial-hit')
    })
  })

  describe('and a prior manifest exists but recorded a non-zero exitCode', () => {
    let harness: Harness
    let outcome: Awaited<ReturnType<IScenesComponent['probe']>>

    beforeEach(async () => {
      harness = await buildHarness()
      const priorManifest: Manifest = {
        version: 'v48',
        files: [],
        exitCode: 5, // prior run failed — don't short-circuit
        date: '2026-04-12T00:00:00.000Z'
      }
      harness.cdnS3.getObject.mockReturnValueOnce({
        promise: jest.fn(async () => ({ Body: Buffer.from(JSON.stringify(priorManifest)) }))
      })
      harness.catalyst.getActiveEntity.mockResolvedValueOnce(buildSceneEntity())
      mockedComputePerAssetDigests.mockResolvedValueOnce({
        digests: new Map([['h-glb', 'digest-1']]),
        skipped: new Map()
      })
      mockedCheckAssetCache.mockResolvedValueOnce(buildAssetCacheResult({ cachedHashes: [], missingHashes: ['h-glb'] }))
      outcome = await harness.scenes.probe(buildProbeArgs())
    })

    afterEach(() => {
      globalThis.fetch = harness.originalFetch
      jest.clearAllMocks()
    })

    it('should fall through past already-converted (prior failure must be retried) and reach the probe pipeline', () => {
      expect(outcome.kind).toBe('partial-hit')
    })
  })

  describe('and force=true bypasses the already-converted check', () => {
    let harness: Harness
    let outcome: Awaited<ReturnType<IScenesComponent['probe']>>

    beforeEach(async () => {
      harness = await buildHarness()
      const priorManifest: Manifest = {
        version: 'v48',
        files: ['hash1_windows'],
        exitCode: 0,
        date: '2026-05-12T00:00:00.000Z'
      }
      harness.cdnS3.getObject.mockReturnValueOnce({
        promise: jest.fn(async () => ({ Body: Buffer.from(JSON.stringify(priorManifest)) }))
      })
      harness.catalyst.getActiveEntity.mockResolvedValueOnce(buildSceneEntity())
      mockedComputePerAssetDigests.mockResolvedValueOnce({ digests: new Map(), skipped: new Map() })
      outcome = await harness.scenes.probe(buildProbeArgs({ force: true }))
    })

    afterEach(() => {
      globalThis.fetch = harness.originalFetch
      jest.clearAllMocks()
    })

    it('should ignore the prior manifest and reach the cache-probe-skipped variant', () => {
      expect(outcome.kind).toBe('cache-probe-skipped')
    })
  })

  describe('and the catalyst fetch throws', () => {
    let harness: Harness
    let outcome: Awaited<ReturnType<IScenesComponent['probe']>>

    beforeEach(async () => {
      harness = await buildHarness()
      harness.catalyst.getActiveEntity.mockRejectedValueOnce(new Error('catalyst 503'))
      outcome = await harness.scenes.probe(buildProbeArgs())
    })

    afterEach(() => {
      globalThis.fetch = harness.originalFetch
      jest.clearAllMocks()
    })

    it('should return catalyst-unreachable with the wrapped error', () => {
      expect(outcome).toEqual({ kind: 'catalyst-unreachable', error: expect.any(Error) })
    })

    it('should not invoke computePerAssetDigests downstream', () => {
      expect(mockedComputePerAssetDigests).not.toHaveBeenCalled()
    })
  })

  describe('and the catalyst returns null for the active entity', () => {
    let harness: Harness
    let outcome: Awaited<ReturnType<IScenesComponent['probe']>>

    beforeEach(async () => {
      harness = await buildHarness()
      harness.catalyst.getActiveEntity.mockResolvedValueOnce(null)
      outcome = await harness.scenes.probe(buildProbeArgs())
    })

    afterEach(() => {
      globalThis.fetch = harness.originalFetch
      jest.clearAllMocks()
    })

    it('should treat a null fetch the same as a thrown fetch and return catalyst-unreachable', () => {
      expect(outcome.kind).toBe('catalyst-unreachable')
    })
  })

  describe('and assetReuseEnabled is false', () => {
    let harness: Harness
    let outcome: Awaited<ReturnType<IScenesComponent['probe']>>

    beforeEach(async () => {
      harness = await buildHarness()
      harness.catalyst.getActiveEntity.mockResolvedValueOnce(buildSceneEntity())
      outcome = await harness.scenes.probe(buildProbeArgs({ assetReuseEnabled: false }))
    })

    afterEach(() => {
      globalThis.fetch = harness.originalFetch
      jest.clearAllMocks()
    })

    it('should return no-asset-reuse carrying the fetched entity', () => {
      expect(outcome.kind).toBe('no-asset-reuse')
    })

    it('should not run the per-asset digest pass', () => {
      expect(mockedComputePerAssetDigests).not.toHaveBeenCalled()
    })
  })

  describe('and doISS is true on a scene', () => {
    let harness: Harness
    let outcome: Awaited<ReturnType<IScenesComponent['probe']>>

    beforeEach(async () => {
      harness = await buildHarness()
      harness.catalyst.getActiveEntity.mockResolvedValueOnce(buildSceneEntity())
      outcome = await harness.scenes.probe(buildProbeArgs({ doISS: true }))
    })

    afterEach(() => {
      globalThis.fetch = harness.originalFetch
      jest.clearAllMocks()
    })

    it('should return no-asset-reuse (doISS jobs always need Unity)', () => {
      expect(outcome.kind).toBe('no-asset-reuse')
    })
  })

  describe('and the entity is not a scene (wearable/emote)', () => {
    let harness: Harness
    let outcome: Awaited<ReturnType<IScenesComponent['probe']>>

    beforeEach(async () => {
      harness = await buildHarness()
      harness.catalyst.getActiveEntity.mockResolvedValueOnce(buildSceneEntity({ type: 'wearable' as any }))
      outcome = await harness.scenes.probe(buildProbeArgs())
    })

    afterEach(() => {
      globalThis.fetch = harness.originalFetch
      jest.clearAllMocks()
    })

    it('should return no-asset-reuse with the entityType preserved for the caller', () => {
      expect(outcome).toEqual(expect.objectContaining({ kind: 'no-asset-reuse', entityType: 'wearable' }))
    })
  })

  describe('and computePerAssetDigests throws', () => {
    let harness: Harness
    let outcome: Awaited<ReturnType<IScenesComponent['probe']>>

    beforeEach(async () => {
      harness = await buildHarness()
      harness.catalyst.getActiveEntity.mockResolvedValueOnce(buildSceneEntity())
      mockedComputePerAssetDigests.mockRejectedValueOnce(new Error('glb parse error'))
      outcome = await harness.scenes.probe(buildProbeArgs())
    })

    afterEach(() => {
      globalThis.fetch = harness.originalFetch
      jest.clearAllMocks()
    })

    it('should return digest-failed with the wrapped error', () => {
      expect(outcome).toEqual({ kind: 'digest-failed', error: expect.any(Error) })
    })

    it('should upload the failed-manifest sentinel under the standard key', () => {
      expect(harness.cdnS3.upload).toHaveBeenCalledWith(
        expect.objectContaining({
          Key: 'manifest/bafy-scene-id_failed.json',
          ContentType: 'application/json'
        })
      )
    })

    it('should set the sentinel Cache-Control short-TTL (1 hour) so a stale sentinel can age out', () => {
      const call = harness.cdnS3.upload.mock.calls.find((c: any) => c[0].Key === 'manifest/bafy-scene-id_failed.json')
      expect(call?.[0].CacheControl).toBe('max-age=3600,s-maxage=3600')
    })

    it('should fire sentry.captureException with the configured phase tag', () => {
      expect(harness.sentry.captureException).toHaveBeenCalledWith(
        expect.any(Error),
        expect.objectContaining({ tags: expect.objectContaining({ phase: 'per-asset-digest' }) })
      )
    })

    it('should not invoke checkAssetCache after digest failure', () => {
      expect(mockedCheckAssetCache).not.toHaveBeenCalled()
    })
  })

  describe('and a custom sentryPhase is provided', () => {
    let harness: Harness

    beforeEach(async () => {
      harness = await buildHarness()
      harness.catalyst.getActiveEntity.mockResolvedValueOnce(buildSceneEntity())
      mockedComputePerAssetDigests.mockRejectedValueOnce(new Error('glb parse error'))
      await harness.scenes.probe(buildProbeArgs({ sentryPhase: 'triage-per-asset-digest' }))
    })

    afterEach(() => {
      globalThis.fetch = harness.originalFetch
      jest.clearAllMocks()
    })

    it('should forward the custom phase tag to the Sentry event', () => {
      expect(harness.sentry.captureException).toHaveBeenCalledWith(
        expect.any(Error),
        expect.objectContaining({ tags: expect.objectContaining({ phase: 'triage-per-asset-digest' }) })
      )
    })
  })

  describe('and the failed-manifest sentinel upload itself throws', () => {
    let harness: Harness
    let outcome: Awaited<ReturnType<IScenesComponent['probe']>>

    beforeEach(async () => {
      harness = await buildHarness()
      harness.catalyst.getActiveEntity.mockResolvedValueOnce(buildSceneEntity())
      mockedComputePerAssetDigests.mockRejectedValueOnce(new Error('glb parse error'))
      harness.cdnS3.upload.mockReturnValueOnce({
        promise: jest.fn(async () => {
          throw new Error('S3 down')
        })
      })
      outcome = await harness.scenes.probe(buildProbeArgs())
    })

    afterEach(() => {
      globalThis.fetch = harness.originalFetch
      jest.clearAllMocks()
    })

    it('should still return digest-failed (sentinel upload failure does not escalate)', () => {
      expect(outcome.kind).toBe('digest-failed')
    })
  })

  describe('and force=true on a scene with valid digests', () => {
    let harness: Harness
    let outcome: Awaited<ReturnType<IScenesComponent['probe']>>

    beforeEach(async () => {
      harness = await buildHarness()
      harness.catalyst.getActiveEntity.mockResolvedValueOnce(buildSceneEntity())
      mockedComputePerAssetDigests.mockResolvedValueOnce({
        digests: new Map([['h-glb', 'digest-1']]),
        skipped: new Map()
      })
      outcome = await harness.scenes.probe(buildProbeArgs({ force: true }))
    })

    afterEach(() => {
      globalThis.fetch = harness.originalFetch
      jest.clearAllMocks()
    })

    it('should return cache-probe-skipped (force honours the operator intent)', () => {
      expect(outcome.kind).toBe('cache-probe-skipped')
    })

    it('should not call checkAssetCache (the cache probe is intentionally bypassed)', () => {
      expect(mockedCheckAssetCache).not.toHaveBeenCalled()
    })

    it('should forward the computed digests so the caller can drive canonical-path uploads', () => {
      expect(outcome).toEqual(
        expect.objectContaining({
          depsDigestByHash: expect.any(Map)
        })
      )
    })
  })

  describe('and checkAssetCache throws', () => {
    let harness: Harness
    let outcome: Awaited<ReturnType<IScenesComponent['probe']>>

    beforeEach(async () => {
      harness = await buildHarness()
      harness.catalyst.getActiveEntity.mockResolvedValueOnce(buildSceneEntity())
      mockedComputePerAssetDigests.mockResolvedValueOnce({
        digests: new Map([['h-glb', 'digest-1']]),
        skipped: new Map()
      })
      mockedCheckAssetCache.mockRejectedValueOnce(new Error('S3 5xx'))
      outcome = await harness.scenes.probe(buildProbeArgs())
    })

    afterEach(() => {
      globalThis.fetch = harness.originalFetch
      jest.clearAllMocks()
    })

    it('should return cache-probe-failed with the wrapped probe error', () => {
      expect(outcome).toEqual(
        expect.objectContaining({
          kind: 'cache-probe-failed',
          error: expect.any(Error)
        })
      )
    })

    it('should forward the digests so the caller can still produce canonical paths from Unity', () => {
      expect(outcome).toEqual(expect.objectContaining({ depsDigestByHash: expect.any(Map) }))
    })
  })

  describe('and the cache probe returns at least one missing hash', () => {
    let harness: Harness
    let outcome: Awaited<ReturnType<IScenesComponent['probe']>>

    beforeEach(async () => {
      harness = await buildHarness()
      harness.catalyst.getActiveEntity.mockResolvedValueOnce(buildSceneEntity())
      mockedComputePerAssetDigests.mockResolvedValueOnce({
        digests: new Map([['h-glb', 'digest-1']]),
        skipped: new Map()
      })
      mockedCheckAssetCache.mockResolvedValueOnce(
        buildAssetCacheResult({ cachedHashes: ['h-tex-1'], missingHashes: ['h-glb'] })
      )
      outcome = await harness.scenes.probe(buildProbeArgs())
    })

    afterEach(() => {
      globalThis.fetch = harness.originalFetch
      jest.clearAllMocks()
    })

    it('should return partial-hit with the cache breakdown attached', () => {
      expect(outcome).toEqual(
        expect.objectContaining({
          kind: 'partial-hit',
          cacheResult: expect.objectContaining({ cachedHashes: ['h-tex-1'], missingHashes: ['h-glb'] })
        })
      )
    })
  })

  describe('and the scenes wrapper invokes the underlying digest pass', () => {
    // Coverage for the wrapper's plumbing: probe() calls the scenes-local
    // `computePerAssetDigests`, which is the SINGLE place that injects redis,
    // metrics, logger, and the metric labels into the underlying free
    // function. Without this test, forgetting to plumb any of those would
    // silently disable the URI cache (or its observability) in production.
    let harness: Harness

    beforeEach(async () => {
      harness = await buildHarness()
      harness.catalyst.getActiveEntity.mockResolvedValueOnce(buildSceneEntity())
      mockedComputePerAssetDigests.mockResolvedValueOnce({
        digests: new Map([['h-glb', 'digest-1']]),
        skipped: new Map()
      })
      mockedCheckAssetCache.mockResolvedValueOnce(
        buildAssetCacheResult({ cachedHashes: [], missingHashes: ['h-glb'] })
      )
      await harness.scenes.probe(buildProbeArgs({ buildTarget: 'windows', abVersion: 'v48' }))
    })

    afterEach(() => {
      globalThis.fetch = harness.originalFetch
      jest.clearAllMocks()
    })

    it('should forward the redis component, metrics, logger, and per-call metric labels', () => {
      expect(mockedComputePerAssetDigests).toHaveBeenCalledWith(
        expect.anything(),
        expect.any(String),
        expect.objectContaining({
          redis: expect.objectContaining({ get: expect.any(Function), set: expect.any(Function) }),
          metrics: expect.objectContaining({ increment: expect.any(Function) }),
          logger: expect.objectContaining({ warn: expect.any(Function) }),
          metricLabels: { build_target: 'windows', ab_version: 'v48' }
        })
      )
    })
  })

  describe('and the cache probe finds every hash already canonical', () => {
    let harness: Harness
    let outcome: Awaited<ReturnType<IScenesComponent['probe']>>

    beforeEach(async () => {
      harness = await buildHarness()
      harness.catalyst.getActiveEntity.mockResolvedValueOnce(buildSceneEntity())
      mockedComputePerAssetDigests.mockResolvedValueOnce({
        digests: new Map([['h-glb', 'digest-1']]),
        skipped: new Map()
      })
      mockedCheckAssetCache.mockResolvedValueOnce(
        buildAssetCacheResult({
          cachedHashes: ['h-glb', 'h-tex-1'],
          missingHashes: [],
          canonicalNameByHash: { 'h-glb': 'h-glb_digest-1_windows', 'h-tex-1': 'h-tex-1_windows' }
        })
      )
      outcome = await harness.scenes.probe(buildProbeArgs())
    })

    afterEach(() => {
      globalThis.fetch = harness.originalFetch
      jest.clearAllMocks()
    })

    it('should return full-hit with the cache result attached', () => {
      expect(outcome.kind).toBe('full-hit')
    })
  })

  describe('and the cache probe returns zero probable assets (no glTFs/textures)', () => {
    let harness: Harness
    let outcome: Awaited<ReturnType<IScenesComponent['probe']>>

    beforeEach(async () => {
      harness = await buildHarness()
      harness.catalyst.getActiveEntity.mockResolvedValueOnce(buildSceneEntity())
      mockedComputePerAssetDigests.mockResolvedValueOnce({ digests: new Map(), skipped: new Map() })
      mockedCheckAssetCache.mockResolvedValueOnce(
        buildAssetCacheResult({ cachedHashes: [], missingHashes: [] })
      )
      outcome = await harness.scenes.probe(buildProbeArgs())
    })

    afterEach(() => {
      globalThis.fetch = harness.originalFetch
      jest.clearAllMocks()
    })

    it('should return partial-hit (totalProbed=0 must not be promoted to full-hit, which would short-circuit Unity for an empty scene)', () => {
      expect(outcome.kind).toBe('partial-hit')
    })
  })
})

describe('when uploadFastPathResult is called', () => {
  describe('and the entity is a scene', () => {
    let harness: Harness

    beforeEach(async () => {
      harness = await buildHarness()
      harness.fetch.mockResolvedValue(fetchResponse(Buffer.from('source-bytes')))
      await harness.scenes.uploadFastPathResult({
        entity: buildSceneEntity(),
        contentServerUrl: 'https://peer.decentraland.org/content',
        cdnBucket: 'test-bucket',
        manifestFile: 'manifest/bafy-scene-id_windows.json',
        entityScopedUploadPath: 'v48/bafy-scene-id',
        abVersion: 'v48',
        cacheResult: buildAssetCacheResult({
          cachedHashes: ['h-glb'],
          canonicalNameByHash: { 'h-glb': 'h-glb_digest-1_windows' }
        })
      })
    })

    afterEach(() => {
      globalThis.fetch = harness.originalFetch
      jest.clearAllMocks()
    })

    it('should upload the entity manifest with the cached canonical filenames', () => {
      const manifestCall = harness.cdnS3.upload.mock.calls.find(
        (c: any) => c[0].Key === 'manifest/bafy-scene-id_windows.json'
      )
      expect(manifestCall).toBeDefined()
      const body = JSON.parse(manifestCall![0].Body)
      expect(body.files).toEqual(['h-glb_digest-1_windows'])
    })

    it('should also upload the scene source files (main.crdt + scene.json + main script)', () => {
      const sourceUploads = harness.cdnS3.upload.mock.calls.filter((c: any) =>
        c[0].Key.startsWith('v48/bafy-scene-id/')
      )
      expect(sourceUploads.length).toBe(3)
    })
  })

  describe('and the entity is not a scene (defense-in-depth guard)', () => {
    let harness: Harness

    beforeEach(async () => {
      harness = await buildHarness()
      harness.fetch.mockResolvedValue(fetchResponse(Buffer.from('source-bytes')))
      await harness.scenes.uploadFastPathResult({
        entity: buildSceneEntity({ type: 'wearable' as any }),
        contentServerUrl: 'https://peer.decentraland.org/content',
        cdnBucket: 'test-bucket',
        manifestFile: 'manifest/bafy-wearable_windows.json',
        entityScopedUploadPath: 'v48/bafy-wearable',
        abVersion: 'v48',
        cacheResult: buildAssetCacheResult({ cachedHashes: ['h-tex'], canonicalNameByHash: { 'h-tex': 'h-tex_windows' } })
      })
    })

    afterEach(() => {
      globalThis.fetch = harness.originalFetch
      jest.clearAllMocks()
    })

    it('should still upload the entity manifest', () => {
      const manifestCall = harness.cdnS3.upload.mock.calls.find(
        (c: any) => c[0].Key === 'manifest/bafy-wearable_windows.json'
      )
      expect(manifestCall).toBeDefined()
    })

    it('should skip the scene source-files upload (guard fires for non-scene entities)', () => {
      expect(harness.fetch).not.toHaveBeenCalled()
    })
  })
})
