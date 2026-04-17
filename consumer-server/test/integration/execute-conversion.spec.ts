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
import { createMetricsComponent } from '@well-known-components/metrics'
import { metricDeclarations } from '../../src/metrics'
import { probeHitCache } from '../../src/logic/asset-reuse'

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

describe('executeConversion: asset-reuse flows', () => {
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

  describe('when every asset hash in the scene is already canonical', () => {
    it('should short-circuit without calling Unity and publish a manifest pointing at canonical paths', async () => {
      // Seed canonical bundles.
      await components.cdnS3
        .putObject({ Bucket: 'test-bucket', Key: 'v48/assets/hGlb_windows', Body: 'glb-bytes' })
        .promise()
      await components.cdnS3
        .putObject({ Bucket: 'test-bucket', Key: 'v48/assets/hTex_windows', Body: 'tex-bytes' })
        .promise()

      mockedGetActiveEntity.mockResolvedValue({
        id: 'bafy-entity-1',
        type: 'scene',
        content: [
          { file: 'model.glb', hash: 'hGlb' },
          { file: 'texture.png', hash: 'hTex' },
          { file: 'main.crdt', hash: 'hMainCrdt' },
          { file: 'scene.json', hash: 'hSceneJson' },
          { file: 'index.js', hash: 'hIndexJs' }
        ],
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
      expect(manifest.files.sort()).toEqual(['hGlb_windows', 'hTex_windows'])
      expect(manifest.version).toBe('v48')

      // Scene source files uploaded to the entity prefix (not canonical).
      expect(await read(components.cdnS3, 'test-bucket', 'v48/bafy-entity-1/main.crdt')).toBe('fake-source-file')
      expect(await read(components.cdnS3, 'test-bucket', 'v48/bafy-entity-1/scene.json')).toBe('fake-source-file')
      expect(await read(components.cdnS3, 'test-bucket', 'v48/bafy-entity-1/index.js')).toBe('fake-source-file')
    })
  })

  describe('when some asset hashes are cached and others are not', () => {
    it('should pass the GLTF/BIN cached hashes to Unity as -cachedHashes and upload new bundles to the canonical prefix', async () => {
      // Seed: hGlb (cached GLB) and hTex (cached texture). Unity will be asked to
      // produce hNewGlb + hNewBuf. Textures are never put in unitySkippableHashes
      // because they can be referenced from non-cached GLTFs.
      await components.cdnS3
        .putObject({ Bucket: 'test-bucket', Key: 'v48/assets/hGlb_windows', Body: 'old-glb' })
        .promise()
      await components.cdnS3
        .putObject({ Bucket: 'test-bucket', Key: 'v48/assets/hTex_windows', Body: 'old-tex' })
        .promise()

      mockedGetActiveEntity.mockResolvedValue({
        id: 'bafy-entity-2',
        type: 'scene',
        content: [
          { file: 'cached.glb', hash: 'hGlb' },
          { file: 'new.glb', hash: 'hNewGlb' },
          { file: 'texture.png', hash: 'hTex' },
          { file: 'geometry.bin', hash: 'hNewBuf' }
        ],
        metadata: {}
      })

      // Mocked Unity: writes the non-cached bundles to outDirectory and returns 0.
      mockedRunConversion.mockImplementation(async (_logger: any, _components: any, options: any) => {
        await fs.mkdir(options.outDirectory, { recursive: true })
        await fs.writeFile(path.join(options.outDirectory, 'hNewGlb_windows'), 'new-glb-bundle')
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

      // Assert -cachedHashes contained only the GLB (the BIN wasn't cached,
      // the PNG wasn't cached either but a texture hit would never appear here).
      const passedOptions = mockedRunConversion.mock.calls[0][2]
      expect((passedOptions.cachedHashes ?? []).sort()).toEqual(['hGlb'])

      // New bundles landed at the canonical prefix.
      expect(await read(components.cdnS3, 'test-bucket', 'v48/assets/hNewGlb_windows')).toContain('new-glb-bundle')
      expect(await read(components.cdnS3, 'test-bucket', 'v48/assets/hNewBuf_windows')).toContain('new-buf-bundle')
      // Pre-seeded canonical bundles untouched (still the old bytes).
      expect(await read(components.cdnS3, 'test-bucket', 'v48/assets/hGlb_windows')).toBe('old-glb')

      // Entity manifest lists all four hashes (new + cached).
      const manifest = JSON.parse(
        (await read(components.cdnS3, 'test-bucket', 'manifest/bafy-entity-2_windows.json')) as string
      )
      expect(manifest.files.sort()).toEqual(
        ['hGlb_windows', 'hNewBuf_windows', 'hNewGlb_windows', 'hTex_windows'].sort()
      )
    })
  })

  describe('when ASSET_REUSE_ENABLED is off', () => {
    it('should skip the cache probe and upload bundles to the entity-scoped path (legacy behaviour)', async () => {
      // Rebuild components with the kill switch flipped off.
      const off = buildComponents(workDir, { assetReuseEnabled: 'false' })
      const metrics = await createMetricsComponent(metricDeclarations, { config: off.config })
      const logs = await createLogComponent({ metrics })
      components = { ...off, metrics, logs }

      mockedGetActiveEntity.mockResolvedValue({
        id: 'bafy-entity-3',
        type: 'scene',
        content: [{ file: 'model.glb', hash: 'hOnlyGlb' }],
        metadata: {}
      })

      mockedRunConversion.mockImplementation(async (_l: any, _c: any, options: any) => {
        await fs.mkdir(options.outDirectory, { recursive: true })
        await fs.writeFile(path.join(options.outDirectory, 'hOnlyGlb_windows'), 'bundle')
        return 0
      })

      const exitCode = await executeConversion(
        components,
        'bafy-entity-3',
        'https://peer.decentraland.org/content',
        false,
        undefined,
        undefined,
        'v48'
      )

      expect(exitCode).toBe(0)
      expect(mockedRunConversion).toHaveBeenCalledTimes(1)
      expect(mockedRunConversion.mock.calls[0][2].cachedHashes).toBeUndefined()

      // Bundle lives at the entity prefix, NOT the canonical prefix.
      expect(await read(components.cdnS3, 'test-bucket', 'v48/bafy-entity-3/hOnlyGlb_windows')).toContain('bundle')
      expect(await read(components.cdnS3, 'test-bucket', 'v48/assets/hOnlyGlb_windows')).toBeNull()
    })
  })
})
