// Coverage for executeTriagePass — the probe-only path used by the triage
// loop. Mirrors execute-conversion.spec.ts's mocking strategy (mock-aws-s3
// + jest-mocked Unity spawn + jest-mocked catalyst entity fetch).

import * as fs from 'fs/promises'
import * as os from 'os'
import * as path from 'path'
import { rimraf } from 'rimraf'

import { createConfigComponent } from '@well-known-components/env-config-provider'
import { createLogComponent } from '@well-known-components/logger'
import { createMetricsComponent } from '@well-known-components/metrics'
import { metricDeclarations } from '../../src/metrics'
import { canonicalFilenameForAsset, computeDepsDigest, probeHitCache } from '../../src/logic/asset-reuse'
import { createScenesComponent } from '../../src/logic/scenes'
import { buildGlb } from '../helpers/glb-fixtures'

// eslint-disable-next-line @typescript-eslint/no-var-requires
const MockAws = require('mock-aws-s3')
import { executeTriagePass } from '../../src/logic/conversion-task'

const mockedRunConversion = jest.fn()
const mockedRunLodsConversion = jest.fn()
const mockedGetActiveEntity = jest.fn()
const mockedGetEntities = jest.fn()
const originalNativeFetch = globalThis.fetch
let mockedFetch: jest.Mock

function buildComponents(bucketBasePath: string) {
  const config = createConfigComponent({
    UNITY_PATH: '/fake/unity',
    PROJECT_PATH: '/fake/project',
    BUILD_TARGET: 'windows',
    AB_VERSION: '',
    AB_VERSION_WINDOWS: 'v48',
    AB_VERSION_MAC: 'v48',
    ASSET_REUSE_ENABLED: 'true',
    CDN_BUCKET: 'test-bucket',
    LOGS_BUCKET: ''
  })

  MockAws.config.basePath = bucketBasePath
  const cdnS3 = new MockAws.S3({ params: { Bucket: 'test-bucket' } })

  const sentry = {
    captureMessage: jest.fn(),
    captureException: jest.fn()
  } as any

  // Inject component-style mocks for catalyst (entity fetches) and
  // unityRunner (Unity spawns). executeTriagePass never spawns Unity but
  // its sibling executeConversion would, so the runner mock is included
  // for consistency.
  const catalyst = {
    getActiveEntity: mockedGetActiveEntity,
    getEntities: mockedGetEntities
  }
  const unityRunner = {
    runConversion: mockedRunConversion,
    runLodsConversion: mockedRunLodsConversion
  }

  return { config, cdnS3, sentry, catalyst, unityRunner }
}

function responseFor(buf: Buffer): any {
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    headers: {
      get: (name: string) => (name.toLowerCase() === 'content-length' ? String(buf.length) : null)
    },
    buffer: async () => buf,
    arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
    text: async () => buf.toString('binary')
  }
}

function setupFetchMock(glbsByHash: Map<string, Buffer>): void {
  const implementation = async (url: any) => {
    const asString = typeof url === 'string' ? url : url?.toString() ?? ''
    for (const [hash, buf] of glbsByHash) {
      if (asString.endsWith(hash)) return responseFor(buf)
    }
    return responseFor(Buffer.from('fake-source-file'))
  }
  mockedFetch.mockImplementation(implementation)
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

describe('when running executeTriagePass against a scene', () => {
  let workDir: string
  let components: any

  beforeEach(async () => {
    workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'triage-pass-test-'))
    const base = buildComponents(workDir)
    const metrics = await createMetricsComponent(metricDeclarations, { config: base.config })
    const logs = await createLogComponent({ metrics })
    const scenes = await createScenesComponent({
      logs,
      config: base.config,
      metrics,
      cdnS3: base.cdnS3,
      sentry: base.sentry,
      catalyst: base.catalyst as any
    })
    components = { ...base, metrics, logs, scenes }

    mockedFetch = jest.fn()
    globalThis.fetch = mockedFetch as any
    mockedFetch.mockResolvedValue(responseFor(Buffer.from('fake-source-file')))

    probeHitCache.clear()
    jest.clearAllMocks()
    mockedFetch.mockResolvedValue(responseFor(Buffer.from('fake-source-file')))
  })

  afterEach(async () => {
    globalThis.fetch = originalNativeFetch
    await rimraf(workDir, { maxRetries: 3 })
  })

  describe('and every asset hash in the scene is already canonical', () => {
    let outcome: Awaited<ReturnType<typeof executeTriagePass>>
    let glbFilename: string
    let texFilename: string

    beforeEach(async () => {
      const content = [
        { file: 'model.glb', hash: 'hGlb' },
        { file: 'texture.png', hash: 'hTex' },
        { file: 'main.crdt', hash: 'hMainCrdt' },
        { file: 'scene.json', hash: 'hSceneJson' },
        { file: 'index.js', hash: 'hIndexJs' }
      ]
      setupFetchMock(new Map([['hGlb', buildGlb(['texture.png'])]]))
      const glbDigest = computeDepsDigest([{ file: 'texture.png', hash: 'hTex' }])
      const digests = new Map([['hGlb', glbDigest]])
      glbFilename = canonicalFilenameForAsset('hGlb', '.glb', 'windows', digests)
      texFilename = canonicalFilenameForAsset('hTex', '.png', 'windows', digests)

      await components.cdnS3
        .putObject({ Bucket: 'test-bucket', Key: `v48/assets/${glbFilename}`, Body: 'glb-bytes' })
        .promise()
      await components.cdnS3
        .putObject({ Bucket: 'test-bucket', Key: `v48/assets/${texFilename}`, Body: 'tex-bytes' })
        .promise()

      mockedGetActiveEntity.mockResolvedValue({
        id: 'bafy-fast-hit',
        type: 'scene',
        content,
        metadata: { main: 'index.js' }
      })

      outcome = await executeTriagePass(
        components,
        'bafy-fast-hit',
        'https://peer.decentraland.org/content',
        false,
        undefined,
        'v48'
      )
    })

    it('should return kind: completed with exit code 0', () => {
      expect(outcome).toEqual({ kind: 'completed', exitCode: 0 })
    })

    it('should not call Unity', () => {
      expect(mockedRunConversion).not.toHaveBeenCalled()
    })

    it('should upload the entity manifest pointing at canonical filenames', async () => {
      const body = await read(components.cdnS3, 'test-bucket', 'manifest/bafy-fast-hit_windows.json')
      const manifest = JSON.parse(body!)
      expect(manifest.files.sort()).toEqual([glbFilename, texFilename].sort())
    })

    it('should upload scene source files to the entity prefix', async () => {
      expect(await read(components.cdnS3, 'test-bucket', 'v48/bafy-fast-hit/scene.json')).toBe('fake-source-file')
    })
  })

  describe('and at least one asset is missing canonical', () => {
    let outcome: Awaited<ReturnType<typeof executeTriagePass>>

    beforeEach(async () => {
      const content = [
        { file: 'model.glb', hash: 'hMissingGlb' },
        { file: 'texture.png', hash: 'hMissingTex' }
      ]
      setupFetchMock(new Map([['hMissingGlb', buildGlb(['texture.png'])]]))

      mockedGetActiveEntity.mockResolvedValue({
        id: 'bafy-cache-miss',
        type: 'scene',
        content,
        metadata: {}
      })

      outcome = await executeTriagePass(
        components,
        'bafy-cache-miss',
        'https://peer.decentraland.org/content',
        false,
        undefined,
        'v48'
      )
    })

    it('should return kind: needs-unity', () => {
      expect(outcome).toEqual({ kind: 'needs-unity' })
    })

    it('should not upload an entity manifest (conversion loop will do that)', async () => {
      expect(await read(components.cdnS3, 'test-bucket', 'manifest/bafy-cache-miss_windows.json')).toBeNull()
    })
  })

  describe('and force=true is set', () => {
    let outcome: Awaited<ReturnType<typeof executeTriagePass>>

    beforeEach(async () => {
      outcome = await executeTriagePass(
        components,
        'bafy-force',
        'https://peer.decentraland.org/content',
        true,
        undefined,
        'v48'
      )
    })

    it('should return kind: needs-unity without fetching the entity', () => {
      expect(outcome).toEqual({ kind: 'needs-unity' })
      expect(mockedGetActiveEntity).not.toHaveBeenCalled()
    })
  })

  describe('and the entity is a wearable (non-scene)', () => {
    let outcome: Awaited<ReturnType<typeof executeTriagePass>>

    beforeEach(async () => {
      mockedGetActiveEntity.mockResolvedValue({
        id: 'bafy-wearable',
        type: 'wearable',
        content: [{ file: 'thumbnail.png', hash: 'hThumb' }],
        metadata: {}
      })

      outcome = await executeTriagePass(
        components,
        'bafy-wearable',
        'https://peer.decentraland.org/content',
        false,
        undefined,
        'v48'
      )
    })

    it('should return kind: needs-unity (wearables always need Unity)', () => {
      expect(outcome).toEqual({ kind: 'needs-unity' })
    })
  })

  describe('and the manifest already exists with exitCode 0 for the same version (already converted)', () => {
    let outcome: Awaited<ReturnType<typeof executeTriagePass>>

    beforeEach(async () => {
      await components.cdnS3
        .putObject({
          Bucket: 'test-bucket',
          Key: 'manifest/bafy-already-done_windows.json',
          Body: JSON.stringify({ version: 'v48', files: ['x_windows'], exitCode: 0, date: 'now' })
        })
        .promise()

      outcome = await executeTriagePass(
        components,
        'bafy-already-done',
        'https://peer.decentraland.org/content',
        false,
        undefined,
        'v48'
      )
    })

    it('should return kind: completed with already-converted exit code 13', () => {
      expect(outcome).toEqual({ kind: 'completed', exitCode: 13 })
    })

    it('should not fetch the entity', () => {
      expect(mockedGetActiveEntity).not.toHaveBeenCalled()
    })
  })

  describe('and the catalyst entity fetch fails', () => {
    let outcome: Awaited<ReturnType<typeof executeTriagePass>>

    beforeEach(async () => {
      mockedGetActiveEntity.mockRejectedValue(new Error('catalyst 502'))

      outcome = await executeTriagePass(
        components,
        'bafy-catalyst-down',
        'https://peer.decentraland.org/content',
        false,
        undefined,
        'v48'
      )
    })

    it('should return kind: needs-unity so the conversion loop retries against the catalyst', () => {
      expect(outcome).toEqual({ kind: 'needs-unity' })
    })
  })
})
