/* eslint-disable @typescript-eslint/no-var-requires */
// End-to-end proof of the `executeConversion` orchestration without needing Unity.
// Uses mock-aws-s3 (file-backed S3 mock) for storage and jest.mock() to replace
// the Unity spawn, catalyst fetches, and the legacy hasContentChange path.
// Covers: full-cache short-circuit, partial-cache Unity invocation with the
// -cachedHashes list, and kill-switch-off falling back to entity-scoped uploads.

import * as fs from 'fs/promises'
import * as os from 'os'
import * as path from 'path'
import { rimraf } from 'rimraf'

import { createConfigComponent } from '@well-known-components/env-config-provider'
import { createLogComponent } from '@well-known-components/logger'
import { createMetricsComponent } from '@dcl/metrics'
import { metricDeclarations } from '../../src/metrics'
import { canonicalFilename, computeDepsDigest, probeHitCache } from '../../src/logic/asset-reuse'

jest.mock('../../src/logic/run-conversion', () => ({
  runConversion: jest.fn(),
  runLodsConversion: jest.fn()
}))
jest.mock('../../src/logic/fetch-entity-by-pointer', () => ({
  getActiveEntity: jest.fn(),
  getEntities: jest.fn()
}))
jest.mock('../../src/logic/has-content-changed-task', () => {
  const real = jest.requireActual('../../src/logic/has-content-changed-task')
  return { ...real, hasContentChange: jest.fn(async () => true) }
})
jest.mock('node-fetch', () => jest.fn())

// eslint-disable-next-line @typescript-eslint/no-var-requires
const MockAws = require('mock-aws-s3')
// eslint-disable-next-line @typescript-eslint/no-var-requires
import fetch from 'node-fetch'
import { runConversion } from '../../src/logic/run-conversion'
import { getActiveEntity } from '../../src/logic/fetch-entity-by-pointer'
import { executeConversion } from '../../src/logic/conversion-task'

const mockedFetch = fetch as unknown as jest.Mock
const mockedRunConversion = runConversion as jest.Mock
const mockedGetActiveEntity = getActiveEntity as jest.Mock

type Params = {
  abVersion?: string
  buildTarget?: string
  assetReuseEnabled?: string
}

function buildComponents(bucketBasePath: string, params: Params = {}) {
  const config = createConfigComponent({
    UNITY_PATH: '/fake/unity',
    PROJECT_PATH: '/fake/project',
    BUILD_TARGET: params.buildTarget ?? 'windows',
    AB_VERSION: '',
    AB_VERSION_WINDOWS: params.abVersion ?? 'v48',
    AB_VERSION_MAC: params.abVersion ?? 'v48',
    ASSET_REUSE_ENABLED: params.assetReuseEnabled ?? 'true',
    CDN_BUCKET: 'test-bucket',
    LOGS_BUCKET: ''
  })

  MockAws.config.basePath = bucketBasePath
  const cdnS3 = new MockAws.S3({ params: { Bucket: 'test-bucket' } })

  const sentry = {
    captureMessage: jest.fn(),
    captureException: jest.fn()
  } as any

  return { config, cdnS3, sentry }
}

async function read(s3: any, Bucket: string, Key: string): Promise<string | null> {
  try {
    const res = await s3.getObject({ Bucket, Key }).promise()
    return res.Body?.toString() ?? null
  } catch (e: any) {
    if (e.statusCode === 404 || e.code === 'NoSuchKey' || e.code === 'NotFound') return null
    throw e
  }
}

describe('when executing a conversion with asset-reuse enabled', () => {
  let workDir: string
  let components: any

  beforeEach(async () => {
    workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'exec-conv-test-'))
    const base = buildComponents(workDir)
    const metrics = await createMetricsComponent(metricDeclarations, { config: base.config })
    const logs = await createLogComponent({ metrics })
    components = { ...base, metrics, logs }

    // Scene source files: respond with a tiny body so uploadSceneSourceFilesToCDN
    // can fetch + S3-PUT without talking to a real catalyst.
    mockedFetch.mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      buffer: async () => Buffer.from('fake-source-file')
    } as any)

    probeHitCache.clear()
    jest.clearAllMocks()
    mockedFetch.mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      buffer: async () => Buffer.from('fake-source-file')
    } as any)
  })

  afterEach(async () => {
    await rimraf(workDir, { maxRetries: 3 })
  })

  describe('and every asset hash in the scene is already canonical', () => {
    it('should short-circuit without calling Unity and publish a manifest pointing at canonical paths', async () => {
      const content = [
        { file: 'model.glb', hash: 'hGlb' },
        { file: 'texture.png', hash: 'hTex' },
        { file: 'main.crdt', hash: 'hMainCrdt' },
        { file: 'scene.json', hash: 'hSceneJson' },
        { file: 'index.js', hash: 'hIndexJs' }
      ]
      const digest = computeDepsDigest(content)
      const glbFilename = canonicalFilename('hGlb', '.glb', 'windows', digest)
      const texFilename = canonicalFilename('hTex', '.png', 'windows', digest)

      // Seed canonical bundles at the composite (glb) / bare (texture) paths.
      await components.cdnS3
        .putObject({ Bucket: 'test-bucket', Key: `v48/assets/${glbFilename}`, Body: 'glb-bytes' })
        .promise()
      await components.cdnS3
        .putObject({ Bucket: 'test-bucket', Key: `v48/assets/${texFilename}`, Body: 'tex-bytes' })
        .promise()

      mockedGetActiveEntity.mockResolvedValue({
        id: 'bafy-entity-1',
        type: 'scene',
        content,
        metadata: { main: 'index.js' }
      })

      const exitCode = await executeConversion(
        components,
        'bafy-entity-1',
        'https://peer.decentraland.org/content',
        false,
        undefined,
        undefined,
        'v48'
      )

      expect(exitCode).toBe(0)
      expect(mockedRunConversion).not.toHaveBeenCalled()

      const manifestBody = await read(components.cdnS3, 'test-bucket', 'manifest/bafy-entity-1_windows.json')
      expect(manifestBody).not.toBeNull()
      const manifest = JSON.parse(manifestBody!)
      expect(manifest.exitCode).toBe(0)
      expect(manifest.files.sort()).toEqual([glbFilename, texFilename].sort())
      expect(manifest.version).toBe('v48')

      // Scene source files uploaded to the entity prefix (not canonical).
      expect(await read(components.cdnS3, 'test-bucket', 'v48/bafy-entity-1/main.crdt')).toBe('fake-source-file')
      expect(await read(components.cdnS3, 'test-bucket', 'v48/bafy-entity-1/scene.json')).toBe('fake-source-file')
      expect(await read(components.cdnS3, 'test-bucket', 'v48/bafy-entity-1/index.js')).toBe('fake-source-file')
    })
  })

  describe('and the entity uses the text .gltf + .bin form', () => {
    it('should fold the deps digest into the gltf canonical path and ignore the buffer in the manifest (no standalone bin bundle exists)', async () => {
      // `.gltf` (text) references `.bin` buffers by URI. The bin contributes
      // to the digest (it changes the GLTF's bundle output bytes if swapped),
      // but Unity never emits a standalone `{binHash}_{target}` bundle — the
      // buffer is inlined into the referencing GLTF's bundle. So the cache
      // probe never asks for a bin canonical and the top-level manifest
      // doesn't list one either.
      const content = [
        { file: 'model.gltf', hash: 'hGltf' },
        { file: 'model.bin', hash: 'hBin' }
      ]
      const digest = computeDepsDigest(content)
      const gltfFilename = canonicalFilename('hGltf', '.gltf', 'windows', digest)
      await components.cdnS3
        .putObject({ Bucket: 'test-bucket', Key: `v48/assets/${gltfFilename}`, Body: 'gltf-bytes' })
        .promise()

      mockedGetActiveEntity.mockResolvedValue({
        id: 'bafy-gltf',
        type: 'scene',
        content,
        metadata: {}
      })

      const exitCode = await executeConversion(
        components,
        'bafy-gltf',
        'https://peer.decentraland.org/content',
        false,
        undefined,
        undefined,
        'v48'
      )

      expect(exitCode).toBe(0)
      // Full short-circuit fires: the gltf is cached and the bin is not
      // probed at all, so there are no missing hashes.
      expect(mockedRunConversion).not.toHaveBeenCalled()

      const manifest = JSON.parse(
        (await read(components.cdnS3, 'test-bucket', 'manifest/bafy-gltf_windows.json')) as string
      )
      expect(manifest.files).toEqual([gltfFilename])
    })
  })

  describe('and the entity has buffers alongside otherwise-cached glbs', () => {
    it('should still short-circuit — the bin never blocks the full-cache hit (regression guard for the P1 review finding)', async () => {
      // Before the fix, `.bin` hashes were probed for a canonical object that
      // Unity never produces. They always landed in `missingHashes`, so any
      // scene with a buffer file (almost all scenes) was permanently
      // prevented from taking the full-cache short-circuit.
      const content = [
        { file: 'mesh.glb', hash: 'hGlbBinRegression' },
        { file: 'mesh.bin', hash: 'hBinRegression' },
        { file: 'skin.png', hash: 'hTexRegression' }
      ]
      const digest = computeDepsDigest(content)
      const glbFilename = canonicalFilename('hGlbBinRegression', '.glb', 'windows', digest)
      // Seed canonical for the probeable kinds (glb, texture) only. The `.bin`
      // intentionally has NO seeded canonical object.
      await components.cdnS3
        .putObject({ Bucket: 'test-bucket', Key: `v48/assets/${glbFilename}`, Body: 'x' })
        .promise()
      await components.cdnS3
        .putObject({ Bucket: 'test-bucket', Key: 'v48/assets/hTexRegression_windows', Body: 'x' })
        .promise()

      mockedGetActiveEntity.mockResolvedValue({
        id: 'bafy-bin-regression',
        type: 'scene',
        content,
        metadata: {}
      })

      const exitCode = await executeConversion(
        components,
        'bafy-bin-regression',
        'https://peer.decentraland.org/content',
        false,
        undefined,
        undefined,
        'v48'
      )

      expect(exitCode).toBe(0)
      expect(mockedRunConversion).not.toHaveBeenCalled()
    })
  })

  describe('and some asset hashes are cached and others are not', () => {
    it('should pass the GLTF/BIN cached hashes to Unity as -cachedHashes and upload new bundles to the canonical prefix', async () => {
      const content = [
        { file: 'cached.glb', hash: 'hGlb' },
        { file: 'new.glb', hash: 'hNewGlb' },
        { file: 'texture.png', hash: 'hTex' },
        { file: 'geometry.bin', hash: 'hNewBuf' }
      ]
      const digest = computeDepsDigest(content)
      const hGlbFilename = canonicalFilename('hGlb', '.glb', 'windows', digest)
      const hNewGlbFilename = canonicalFilename('hNewGlb', '.glb', 'windows', digest)

      // Seed: hGlb (cached GLB, composite path) and hTex (cached texture, bare path).
      await components.cdnS3
        .putObject({ Bucket: 'test-bucket', Key: `v48/assets/${hGlbFilename}`, Body: 'old-glb' })
        .promise()
      await components.cdnS3
        .putObject({ Bucket: 'test-bucket', Key: 'v48/assets/hTex_windows', Body: 'old-tex' })
        .promise()

      mockedGetActiveEntity.mockResolvedValue({
        id: 'bafy-entity-2',
        type: 'scene',
        content,
        metadata: {}
      })

      // Mocked Unity: writes the non-cached bundles to outDirectory and returns 0.
      // GLB output uses the composite filename (Unity-side depsDigest naming);
      // BIN stays at the bare `{hash}_{target}` form.
      mockedRunConversion.mockImplementation(async (_logger: any, _components: any, options: any) => {
        expect(options.depsDigest).toBe(digest)
        await fs.mkdir(options.outDirectory, { recursive: true })
        await fs.writeFile(path.join(options.outDirectory, hNewGlbFilename), 'new-glb-bundle')
        await fs.writeFile(path.join(options.outDirectory, 'hNewBuf_windows'), 'new-buf-bundle')
        return 0
      })

      const exitCode = await executeConversion(
        components,
        'bafy-entity-2',
        'https://peer.decentraland.org/content',
        false,
        undefined,
        undefined,
        'v48'
      )

      expect(exitCode).toBe(0)
      expect(mockedRunConversion).toHaveBeenCalledTimes(1)

      // Assert -cachedHashes contained only the GLB.
      const passedOptions = mockedRunConversion.mock.calls[0][2]
      expect((passedOptions.cachedHashes ?? []).sort()).toEqual(['hGlb'])

      // New bundles landed at their canonical paths.
      expect(await read(components.cdnS3, 'test-bucket', `v48/assets/${hNewGlbFilename}`)).toContain('new-glb-bundle')
      expect(await read(components.cdnS3, 'test-bucket', 'v48/assets/hNewBuf_windows')).toContain('new-buf-bundle')
      // Pre-seeded canonical glb untouched (still the old bytes).
      expect(await read(components.cdnS3, 'test-bucket', `v48/assets/${hGlbFilename}`)).toBe('old-glb')

      // Entity manifest lists all four bundle filenames (new + cached).
      const manifest = JSON.parse(
        (await read(components.cdnS3, 'test-bucket', 'manifest/bafy-entity-2_windows.json')) as string
      )
      expect(manifest.files.sort()).toEqual(
        [hGlbFilename, 'hNewBuf_windows', hNewGlbFilename, 'hTex_windows'].sort()
      )
    })
  })

  describe('and ASSET_REUSE_ENABLED is off and the canonical prefix is fully populated', () => {
    let exitCode: number

    beforeEach(async () => {
      // Rebuild components with the kill switch flipped off.
      const off = buildComponents(workDir, { assetReuseEnabled: 'false' })
      const metrics = await createMetricsComponent(metricDeclarations, { config: off.config })
      const logs = await createLogComponent({ metrics })
      components = { ...off, metrics, logs }

      // Seed canonical for every hash in the scene — full-cache short-circuit
      // scenario. The kill switch must bypass it symmetrically to force/doISS,
      // and must never touch the canonical prefix while off.
      await components.cdnS3
        .putObject({ Bucket: 'test-bucket', Key: 'v48/assets/hOnlyGlb_windows', Body: 'cached-glb' })
        .promise()

      mockedGetActiveEntity.mockResolvedValue({
        id: 'bafy-entity-3',
        type: 'scene',
        content: [{ file: 'model.glb', hash: 'hOnlyGlb' }],
        metadata: {}
      })

      mockedRunConversion.mockImplementation(async (_l: any, _c: any, options: any) => {
        await fs.mkdir(options.outDirectory, { recursive: true })
        await fs.writeFile(path.join(options.outDirectory, 'hOnlyGlb_windows'), 'freshly-converted')
        return 0
      })

      exitCode = await executeConversion(
        components,
        'bafy-entity-3',
        'https://peer.decentraland.org/content',
        false,
        undefined,
        undefined,
        'v48'
      )
    })

    it('should return exit code 0', () => {
      expect(exitCode).toBe(0)
    })

    it('should invoke Unity despite the cache being warm', () => {
      expect(mockedRunConversion).toHaveBeenCalledTimes(1)
    })

    it('should NOT pass a cachedHashes list to Unity', () => {
      expect(mockedRunConversion.mock.calls[0][2].cachedHashes).toBeUndefined()
    })

    it('should upload the freshly-converted bundle to the entity-scoped path (reuse path is gated off by the kill switch)', async () => {
      expect(await read(components.cdnS3, 'test-bucket', 'v48/bafy-entity-3/hOnlyGlb_windows')).toContain(
        'freshly-converted'
      )
    })

    it('should leave the pre-seeded canonical bytes untouched', async () => {
      expect(await read(components.cdnS3, 'test-bucket', 'v48/assets/hOnlyGlb_windows')).toBe('cached-glb')
    })
  })

  describe('and force=true and the canonical prefix is fully populated', () => {
    let exitCode: number

    beforeEach(async () => {
      // Seed canonical for every hash in the scene — this is the full-cache
      // short-circuit scenario. With force=true, that must be bypassed.
      await components.cdnS3
        .putObject({ Bucket: 'test-bucket', Key: 'v48/assets/hGlb_windows', Body: 'cached-glb' })
        .promise()

      mockedGetActiveEntity.mockResolvedValue({
        id: 'bafy-force',
        type: 'scene',
        content: [{ file: 'model.glb', hash: 'hGlb' }],
        metadata: {}
      })

      mockedRunConversion.mockImplementation(async (_l: any, _c: any, options: any) => {
        await fs.mkdir(options.outDirectory, { recursive: true })
        await fs.writeFile(path.join(options.outDirectory, 'hGlb_windows'), 'freshly-converted')
        return 0
      })

      exitCode = await executeConversion(
        components,
        'bafy-force',
        'https://peer.decentraland.org/content',
        /* force */ true,
        undefined,
        undefined,
        'v48'
      )
    })

    it('should return exit code 0', () => {
      expect(exitCode).toBe(0)
    })

    it('should invoke Unity despite the cache being warm', () => {
      expect(mockedRunConversion).toHaveBeenCalledTimes(1)
    })

    it('should NOT pass a cachedHashes list to Unity', () => {
      expect(mockedRunConversion.mock.calls[0][2].cachedHashes).toBeUndefined()
    })

    it('should upload the freshly-converted bundle to the entity-scoped path (reuse path is gated off by force)', async () => {
      expect(await read(components.cdnS3, 'test-bucket', 'v48/bafy-force/hGlb_windows')).toContain('freshly-converted')
    })

    it('should leave the pre-seeded canonical bytes untouched', async () => {
      expect(await read(components.cdnS3, 'test-bucket', 'v48/assets/hGlb_windows')).toBe('cached-glb')
    })
  })

  describe('and doISS=true and the canonical prefix is fully populated', () => {
    let exitCode: number

    beforeEach(async () => {
      // Seed canonical for every hash in the scene — full-cache short-circuit
      // scenario. doISS must bypass it. The gate lives in `useAssetReuse` at
      // conversion-task.ts:403 (`!doISS && ...`); without it, v2004 ISS
      // conversions would pollute the v48 canonical prefix (or vice-versa).
      await components.cdnS3
        .putObject({ Bucket: 'test-bucket', Key: 'v48/assets/hGlb_windows', Body: 'cached-glb' })
        .promise()

      mockedGetActiveEntity.mockResolvedValue({
        id: 'bafy-iss',
        type: 'scene',
        content: [{ file: 'model.glb', hash: 'hGlb' }],
        metadata: {}
      })

      mockedRunConversion.mockImplementation(async (_l: any, _c: any, options: any) => {
        await fs.mkdir(options.outDirectory, { recursive: true })
        await fs.writeFile(path.join(options.outDirectory, 'hGlb_windows'), 'freshly-converted')
        return 0
      })

      exitCode = await executeConversion(
        components,
        'bafy-iss',
        'https://peer.decentraland.org/content',
        /* force */ false,
        undefined,
        /* doISS */ true,
        'v48'
      )
    })

    it('should return exit code 0', () => {
      expect(exitCode).toBe(0)
    })

    it('should invoke Unity despite the cache being warm', () => {
      expect(mockedRunConversion).toHaveBeenCalledTimes(1)
    })

    it('should NOT pass a cachedHashes list to Unity', () => {
      expect(mockedRunConversion.mock.calls[0][2].cachedHashes).toBeUndefined()
    })

    it('should upload the freshly-converted bundle to the entity-scoped path (reuse path is gated off by doISS)', async () => {
      expect(await read(components.cdnS3, 'test-bucket', 'v48/bafy-iss/hGlb_windows')).toContain('freshly-converted')
    })

    it('should leave the pre-seeded canonical bytes untouched', async () => {
      expect(await read(components.cdnS3, 'test-bucket', 'v48/assets/hGlb_windows')).toBe('cached-glb')
    })
  })

  describe('and the entity is not a scene (wearable/emote)', () => {
    let exitCode: number

    beforeEach(async () => {
      // Seed canonical to make the full-cache scenario available — but it
      // should be ignored because reuse is scene-only.
      await components.cdnS3
        .putObject({ Bucket: 'test-bucket', Key: 'v48/assets/hWearableGlb_windows', Body: 'cached' })
        .promise()

      mockedGetActiveEntity.mockResolvedValue({
        id: 'bafy-wearable',
        type: 'wearable',
        content: [{ file: 'model.glb', hash: 'hWearableGlb' }],
        metadata: {}
      })

      mockedRunConversion.mockImplementation(async (_l: any, _c: any, options: any) => {
        await fs.mkdir(options.outDirectory, { recursive: true })
        await fs.writeFile(path.join(options.outDirectory, 'hWearableGlb_windows'), 'new-bundle')
        return 0
      })

      exitCode = await executeConversion(
        components,
        'bafy-wearable',
        'https://peer.decentraland.org/content',
        false,
        undefined,
        undefined,
        'v48'
      )
    })

    it('should return exit code 0', () => {
      expect(exitCode).toBe(0)
    })

    it('should invoke Unity because the reuse path is scene-only', () => {
      expect(mockedRunConversion).toHaveBeenCalledTimes(1)
    })

    it('should NOT pass a cachedHashes list to Unity', () => {
      expect(mockedRunConversion.mock.calls[0][2].cachedHashes).toBeUndefined()
    })

    it('should upload the bundle to the entity-scoped path', async () => {
      expect(await read(components.cdnS3, 'test-bucket', 'v48/bafy-wearable/hWearableGlb_windows')).toContain(
        'new-bundle'
      )
    })

    it('should leave the canonical prefix untouched', async () => {
      expect(await read(components.cdnS3, 'test-bucket', 'v48/assets/hWearableGlb_windows')).toBe('cached')
    })
  })

  describe('and the short-circuit manifest upload fails', () => {
    let thrown: any
    let sentryCalls: any[]

    beforeEach(async () => {
      // Full-cache setup so we enter the short-circuit. Entity has only the glb
      // (no textures/bins), so the digest is the sha256-truncation of an empty
      // dep list — same for every such scene.
      const content = [{ file: 'model.glb', hash: 'hGlb' }]
      const digest = computeDepsDigest(content)
      const glbFilename = canonicalFilename('hGlb', '.glb', 'windows', digest)
      await components.cdnS3
        .putObject({ Bucket: 'test-bucket', Key: `v48/assets/${glbFilename}`, Body: 'cached' })
        .promise()

      mockedGetActiveEntity.mockResolvedValue({
        id: 'bafy-shortfail',
        type: 'scene',
        content,
        metadata: {}
      })

      // Fail the manifest S3.upload specifically — leave getObject / headObject
      // alone so the canonical probe still hits.
      const realUpload = components.cdnS3.upload.bind(components.cdnS3)
      jest.spyOn(components.cdnS3, 'upload').mockImplementation((params: any) => {
        if (params.Key === 'manifest/bafy-shortfail_windows.json') {
          return { promise: async () => Promise.reject(new Error('simulated S3 manifest upload failure')) } as any
        }
        return realUpload(params)
      })

      sentryCalls = components.sentry.captureMessage.mock.calls
      thrown = null
      try {
        await executeConversion(
          components,
          'bafy-shortfail',
          'https://peer.decentraland.org/content',
          false,
          undefined,
          undefined,
          'v48'
        )
      } catch (err) {
        thrown = err
      }
    })

    it('should re-throw so SQS retries the job', () => {
      expect(thrown).toBeInstanceOf(Error)
      expect((thrown as Error).message).toContain('simulated S3 manifest upload failure')
    })

    it('should capture a Sentry event tagged as a short-circuit failure', () => {
      expect(sentryCalls.length).toBeGreaterThan(0)
      const call = sentryCalls[0]
      expect(call[0]).toContain('short-circuit')
      expect(call[1].tags.shortCircuit).toBe('true')
      expect(call[1].tags.entityId).toBe('bafy-shortfail')
    })

    it('should NOT publish the entity manifest', async () => {
      // Upload was mocked to reject — nothing should actually be at that key.
      expect(await read(components.cdnS3, 'test-bucket', 'manifest/bafy-shortfail_windows.json')).toBeNull()
    })
  })

  describe('and the cache probe itself throws (S3 transient error)', () => {
    let exitCode: number
    let composedGlbFilename: string

    beforeEach(async () => {
      const content = [{ file: 'model.glb', hash: 'hGlb' }]
      const digest = computeDepsDigest(content)
      composedGlbFilename = canonicalFilename('hGlb', '.glb', 'windows', digest)

      mockedGetActiveEntity.mockResolvedValue({
        id: 'bafy-probefail',
        type: 'scene',
        content,
        metadata: {}
      })

      // Fail the headObject that checkAssetCache issues — simulates a transient
      // S3 500 or connection reset. headObject is called only by the probe; the
      // real path continues to use putObject / getObject / upload.
      const realHead = components.cdnS3.headObject.bind(components.cdnS3)
      jest.spyOn(components.cdnS3, 'headObject').mockImplementation((params: any) => {
        if (params.Key.startsWith('v48/assets/')) {
          const err: any = new Error('simulated S3 probe failure')
          err.statusCode = 500
          return { promise: async () => Promise.reject(err) } as any
        }
        return realHead(params)
      })

      mockedRunConversion.mockImplementation(async (_l: any, _c: any, options: any) => {
        // Probe failure must NOT zero out depsDigest — otherwise glb bundles
        // would revert to bare names and reintroduce the cross-scene collision.
        expect(options.depsDigest).toBe(digest)
        await fs.mkdir(options.outDirectory, { recursive: true })
        await fs.writeFile(path.join(options.outDirectory, composedGlbFilename), 'bundle')
        return 0
      })

      exitCode = await executeConversion(
        components,
        'bafy-probefail',
        'https://peer.decentraland.org/content',
        false,
        undefined,
        undefined,
        'v48'
      )
    })

    it('should fall back to a full conversion (not throw)', () => {
      expect(exitCode).toBe(0)
      expect(mockedRunConversion).toHaveBeenCalledTimes(1)
    })

    it('should pass no cached hashes to Unity (cacheResult was set to null)', () => {
      expect(mockedRunConversion.mock.calls[0][2].cachedHashes).toBeUndefined()
    })

    it('should still upload to the canonical prefix at the composite glb path', async () => {
      expect(await read(components.cdnS3, 'test-bucket', `v48/assets/${composedGlbFilename}`)).toContain('bundle')
    })
  })

  describe('and fetching the entity fails', () => {
    let exitCode: number

    beforeEach(async () => {
      mockedGetActiveEntity.mockRejectedValue(new Error('catalyst unavailable'))

      mockedRunConversion.mockImplementation(async (_l: any, _c: any, options: any) => {
        await fs.mkdir(options.outDirectory, { recursive: true })
        await fs.writeFile(path.join(options.outDirectory, 'hNoEntity_windows'), 'bundle')
        return 0
      })

      exitCode = await executeConversion(
        components,
        'bafy-no-entity',
        'https://peer.decentraland.org/content',
        false,
        undefined,
        undefined,
        'v48'
      )
    })

    it('should return exit code 0 instead of throwing', () => {
      expect(exitCode).toBe(0)
    })

    it('should still invoke Unity so the scene gets converted', () => {
      expect(mockedRunConversion).toHaveBeenCalledTimes(1)
    })

    it('should NOT pass a cachedHashes list to Unity (reuse path requires the entity)', () => {
      expect(mockedRunConversion.mock.calls[0][2].cachedHashes).toBeUndefined()
    })

    it('should upload the bundle to the entity-scoped path', async () => {
      expect(await read(components.cdnS3, 'test-bucket', 'v48/bafy-no-entity/hNoEntity_windows')).toContain('bundle')
    })

    it('should leave the canonical prefix untouched', async () => {
      expect(await read(components.cdnS3, 'test-bucket', 'v48/assets/hNoEntity_windows')).toBeNull()
    })
  })
})
