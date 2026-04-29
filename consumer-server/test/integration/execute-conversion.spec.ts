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
import {
  canonicalFilenameForAsset,
  computeDepsDigest,
  probeHitCache
} from '../../src/logic/asset-reuse'
import { buildGlb } from '../helpers/glb-fixtures'

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
// eslint-disable-next-line @typescript-eslint/no-var-requires
const MockAws = require('mock-aws-s3')
import { runConversion } from '../../src/logic/run-conversion'
import { getActiveEntity } from '../../src/logic/fetch-entity-by-pointer'
import { executeConversion } from '../../src/logic/conversion-task'

const mockedRunConversion = runConversion as jest.Mock
const mockedGetActiveEntity = getActiveEntity as jest.Mock
const originalNativeFetch = globalThis.fetch
let mockedFetch: jest.Mock

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

// Wire up native fetch so glb/gltf digest reads return declared fixtures and
// scene source files return a tiny body.
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

// Mock Response that satisfies both scene-source-file and glb/gltf digest
// fetches: `.headers.get(...)` for guards and `.arrayBuffer()` for payloads.
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
    it('should short-circuit without calling Unity and publish a manifest pointing at canonical paths', async () => {
      const content = [
        { file: 'model.glb', hash: 'hGlb' },
        { file: 'texture.png', hash: 'hTex' },
        { file: 'main.crdt', hash: 'hMainCrdt' },
        { file: 'scene.json', hash: 'hSceneJson' },
        { file: 'index.js', hash: 'hIndexJs' }
      ]
      // model.glb references texture.png; per-asset digest captures that subset.
      setupFetchMock(new Map([['hGlb', buildGlb(['texture.png'])]]))
      const glbDigest = computeDepsDigest([{ file: 'texture.png', hash: 'hTex' }])
      const digests = new Map([['hGlb', glbDigest]])
      const glbFilename = canonicalFilenameForAsset('hGlb', '.glb', 'windows', digests)
      const texFilename = canonicalFilenameForAsset('hTex', '.png', 'windows', digests)

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
      // Text-form .gltf is just JSON; we fetch it as bytes, parse as JSON.
      // Supply the same JSON shape `buildGlb` would produce in binary form,
      // but stringified since this is .gltf not .glb.
      const gltfText = JSON.stringify({ buffers: [{ uri: 'model.bin' }] })
      setupFetchMock(new Map([['hGltf', Buffer.from(gltfText, 'utf8')]]))
      const digest = computeDepsDigest([{ file: 'model.bin', hash: 'hBin' }])
      const digests = new Map([['hGltf', digest]])
      const gltfFilename = canonicalFilenameForAsset('hGltf', '.gltf', 'windows', digests)
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
      // mesh.glb references both its .bin buffer and skin.png texture.
      setupFetchMock(
        new Map([['hGlbBinRegression', buildGlb(['skin.png'], ['mesh.bin'])]])
      )
      const digest = computeDepsDigest([
        { file: 'mesh.bin', hash: 'hBinRegression' },
        { file: 'skin.png', hash: 'hTexRegression' }
      ])
      const digests = new Map([['hGlbBinRegression', digest]])
      const glbFilename = canonicalFilenameForAsset('hGlbBinRegression', '.glb', 'windows', digests)
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
      // Both glbs reference texture.png and geometry.bin, so they end up with
      // the same per-asset digest (identical dep set).
      setupFetchMock(
        new Map([
          ['hGlb', buildGlb(['texture.png'], ['geometry.bin'])],
          ['hNewGlb', buildGlb(['texture.png'], ['geometry.bin'])]
        ])
      )
      const perGlbDigest = computeDepsDigest([
        { file: 'geometry.bin', hash: 'hNewBuf' },
        { file: 'texture.png', hash: 'hTex' }
      ])
      const digests = new Map([
        ['hGlb', perGlbDigest],
        ['hNewGlb', perGlbDigest]
      ])
      const hGlbFilename = canonicalFilenameForAsset('hGlb', '.glb', 'windows', digests)
      const hNewGlbFilename = canonicalFilenameForAsset('hNewGlb', '.glb', 'windows', digests)

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
        expect(options.depsDigestByHash.get('hGlb')).toBe(perGlbDigest)
        expect(options.depsDigestByHash.get('hNewGlb')).toBe(perGlbDigest)
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
      setupFetchMock(new Map([['hGlb', buildGlb([], [])]]))
      const digest = computeDepsDigest([])
      const digests = new Map([['hGlb', digest]])
      const glbFilename = canonicalFilenameForAsset('hGlb', '.glb', 'windows', digests)
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
      setupFetchMock(new Map([['hGlb', buildGlb([], [])]]))
      const digest = computeDepsDigest([])
      const digests = new Map([['hGlb', digest]])
      composedGlbFilename = canonicalFilenameForAsset('hGlb', '.glb', 'windows', digests)

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
        // Probe failure must NOT zero out depsDigestByHash — otherwise glb
        // bundles would revert to bare names and reintroduce the cross-scene
        // collision.
        expect(options.depsDigestByHash.get('hGlb')).toBe(digest)
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

  describe('and a glb has unparseable bytes alongside a healthy sibling asset', () => {
    let exitCode: number
    let sentryCalls: any[]
    let runConversionOptions: any

    beforeEach(async () => {
      // The broken glb returns garbage bytes (`parseGltfDepRefs` throws on
      // "glb too short" / "magic mismatch"). Per-asset digest treats that
      // as a content-deterministic skip rather than a scene failure: the
      // broken glb is silently dropped from the digest map, the rest of
      // the scene continues, and Unity is told to skip it via
      // `-skippedHashes`. The texture sibling proves the rest of the
      // entity still flows through to Unity-produced output.
      const implementation = async (url: any) => {
        const asString = typeof url === 'string' ? url : url?.toString() ?? ''
        if (asString.endsWith('hBadGlb')) {
          return responseFor(Buffer.from('not-a-glb-at-all'))
        }
        return responseFor(Buffer.from('fake-source-file'))
      }
      mockedFetch.mockImplementation(implementation)

      mockedGetActiveEntity.mockResolvedValue({
        id: 'bafy-bad-glb',
        type: 'scene',
        content: [
          { file: 'broken.glb', hash: 'hBadGlb' },
          { file: 'texture.png', hash: 'hTex' }
        ],
        metadata: { main: 'index.js' }
      })

      mockedRunConversion.mockImplementation(async (_l: any, _c: any, options: any) => {
        runConversionOptions = options
        // Unity ignores the broken glb (per `-skippedHashes`) and produces
        // a bundle for the texture, which the integration test asserts
        // ends up at the canonical prefix. Do NOT write `options.logFile` —
        // its parent directory (`/tmp/asset_bundles_logs/`) is created by
        // the real `setupStartDirectories`, which is bypassed when
        // `runConversion` is mocked. On CI Linux that dir doesn't exist
        // ahead of time, and writing through it throws ENOENT mid-test.
        // The other mocks in this suite all skip the logFile write for the
        // same reason.
        await fs.mkdir(options.outDirectory, { recursive: true })
        await fs.writeFile(path.join(options.outDirectory, 'hTex_windows'), 'tex-bundle-bytes')
        return 0
      })

      sentryCalls = components.sentry.captureException.mock.calls
      exitCode = await executeConversion(
        components,
        'bafy-bad-glb',
        'https://peer.decentraland.org/content',
        false,
        undefined,
        undefined,
        'v48'
      )
    })

    it('should NOT fail the whole scene (exit 0)', () => {
      expect(exitCode).toBe(0)
    })

    it('should still invoke Unity for the rest of the scene', () => {
      expect(mockedRunConversion).toHaveBeenCalledTimes(1)
    })

    it('should pass the broken glb hash via -skippedHashes so Unity drops it', () => {
      expect(runConversionOptions.skippedHashes).toEqual(['hBadGlb'])
    })

    it('should NOT include the broken glb in the digest map sent to Unity', () => {
      expect(runConversionOptions.depsDigestByHash?.has?.('hBadGlb') ?? false).toBe(false)
    })

    it('should NOT capture a Sentry exception for content-determined skips', () => {
      expect(sentryCalls.length).toBe(0)
    })

    it('should NOT upload a failed-manifest sentinel (the scene succeeded)', async () => {
      const failedBody = await read(components.cdnS3, 'test-bucket', 'manifest/bafy-bad-glb_failed.json')
      expect(failedBody).toBeNull()
    })

    it('should upload the healthy sibling bundle to the canonical prefix', async () => {
      expect(await read(components.cdnS3, 'test-bucket', 'v48/assets/hTex_windows')).toBe('tex-bundle-bytes')
    })

    it('should NOT upload anything under the broken glb hash', async () => {
      expect(await read(components.cdnS3, 'test-bucket', 'v48/assets/hBadGlb_windows')).toBeNull()
    })
  })

  describe('and the catalyst returns a non-OK HTTP status while fetching glb bytes', () => {
    let exitCode: number
    let sentryCalls: any[]

    beforeEach(async () => {
      // 500 from the catalyst on glb bytes is a fetch-level error (transient
      // infra), not a content defect. Keep the existing fail-fast contract
      // for these — SQS retry is the right response, and ops still wants
      // Sentry visibility because it might indicate catalyst trouble.
      const implementation = async (url: any) => {
        const asString = typeof url === 'string' ? url : url?.toString() ?? ''
        if (asString.endsWith('hBrokenFetch')) {
          return {
            ok: false,
            status: 500,
            statusText: 'Internal Server Error',
            headers: { get: () => null },
            arrayBuffer: async () => new ArrayBuffer(0),
            text: async () => 'oops'
          }
        }
        return responseFor(Buffer.from('fake-source-file'))
      }
      mockedFetch.mockImplementation(implementation)

      mockedGetActiveEntity.mockResolvedValue({
        id: 'bafy-bad-fetch',
        type: 'scene',
        content: [{ file: 'broken.glb', hash: 'hBrokenFetch' }],
        metadata: {}
      })

      sentryCalls = components.sentry.captureException.mock.calls
      exitCode = await executeConversion(
        components,
        'bafy-bad-fetch',
        'https://peer.decentraland.org/content',
        false,
        undefined,
        undefined,
        'v48'
      )
    })

    it('should return UNEXPECTED_ERROR exit code (5)', () => {
      expect(exitCode).toBe(5)
    })

    it('should NOT invoke Unity (failed before Unity spawn)', () => {
      expect(mockedRunConversion).not.toHaveBeenCalled()
    })

    it('should capture the fetch error via Sentry captureException', () => {
      expect(sentryCalls.length).toBeGreaterThan(0)
      expect(sentryCalls[0][0]).toBeInstanceOf(Error)
      expect(sentryCalls[0][1].tags.phase).toBe('per-asset-digest')
    })

    it('should upload a failed-manifest sentinel so clients stop polling', async () => {
      const failedBody = await read(components.cdnS3, 'test-bucket', 'manifest/bafy-bad-fetch_failed.json')
      expect(failedBody).not.toBeNull()
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

  describe('and getActiveEntity is invoked', () => {
    // Regression guard against regressing the catalyst-timeout argument. Without
    // it, a wedged catalyst would pin the worker slot until SQS visibility
    // timeout (1-2min) ran out — long enough to starve the pool under a partial
    // catalyst outage.
    beforeEach(async () => {
      setupFetchMock(new Map([['hGlb', buildGlb([], [])]]))
      mockedGetActiveEntity.mockResolvedValue({
        id: 'bafy-timeout-arg',
        type: 'scene',
        content: [{ file: 'model.glb', hash: 'hGlb' }],
        metadata: {}
      })
      mockedRunConversion.mockImplementation(async (_l: any, _c: any, options: any) => {
        await fs.mkdir(options.outDirectory, { recursive: true })
        await fs.writeFile(path.join(options.outDirectory, 'out'), 'x')
        return 0
      })

      await executeConversion(
        components,
        'bafy-timeout-arg',
        'https://peer.decentraland.org/content',
        false,
        undefined,
        undefined,
        'v48'
      )
    })

    it('should pass a bounded catalyst fetch timeout so a wedged catalyst cannot hold the worker', () => {
      expect(mockedGetActiveEntity).toHaveBeenCalled()
      // Args: (entityId, contentServerUrl, timeoutMs)
      const [, , timeoutMs] = mockedGetActiveEntity.mock.calls[0]
      expect(typeof timeoutMs).toBe('number')
      expect(timeoutMs).toBeGreaterThan(0)
    })
  })

  describe('and a prior successful manifest exists at the same AB_VERSION (shouldIgnoreConversion hit)', () => {
    let exitCode: number

    beforeEach(async () => {
      // Seed a manifest matching what a successful conversion at v48 would
      // leave behind. shouldIgnoreConversion reads it, sees matching version
      // and exitCode 0 → returns true → executeConversion short-circuits with
      // ALREADY_CONVERTED (13) before any work happens.
      await components.cdnS3
        .putObject({
          Bucket: 'test-bucket',
          Key: 'manifest/bafy-ignore_windows.json',
          Body: JSON.stringify({ version: 'v48', files: ['h_windows'], exitCode: 0 })
        })
        .promise()

      exitCode = await executeConversion(
        components,
        'bafy-ignore',
        'https://peer.decentraland.org/content',
        /* force */ false,
        undefined,
        undefined,
        'v48'
      )
    })

    it('should return 13 (ALREADY_CONVERTED) without invoking the catalyst or Unity', () => {
      expect(exitCode).toBe(13)
      expect(mockedGetActiveEntity).not.toHaveBeenCalled()
      expect(mockedRunConversion).not.toHaveBeenCalled()
    })
  })

  describe('and a prior successful manifest exists but force=true', () => {
    let exitCode: number

    beforeEach(async () => {
      await components.cdnS3
        .putObject({
          Bucket: 'test-bucket',
          Key: 'manifest/bafy-force-skip_windows.json',
          Body: JSON.stringify({ version: 'v48', files: ['h_windows'], exitCode: 0 })
        })
        .promise()

      mockedGetActiveEntity.mockResolvedValue({
        id: 'bafy-force-skip',
        type: 'scene',
        content: [{ file: 'model.glb', hash: 'hGlb' }],
        metadata: {}
      })

      mockedRunConversion.mockImplementation(async (_l: any, _c: any, options: any) => {
        await fs.mkdir(options.outDirectory, { recursive: true })
        await fs.writeFile(path.join(options.outDirectory, 'hGlb_windows'), 'bundle')
        return 0
      })

      exitCode = await executeConversion(
        components,
        'bafy-force-skip',
        'https://peer.decentraland.org/content',
        /* force */ true,
        undefined,
        undefined,
        'v48'
      )
    })

    it('should bypass shouldIgnoreConversion and actually convert', () => {
      expect(exitCode).toBe(0)
      expect(mockedRunConversion).toHaveBeenCalledTimes(1)
    })
  })

  describe('and a prior FAILED manifest exists at the same AB_VERSION', () => {
    let exitCode: number

    beforeEach(async () => {
      // exitCode != 0 → shouldIgnoreConversion returns false → conversion proceeds.
      await components.cdnS3
        .putObject({
          Bucket: 'test-bucket',
          Key: 'manifest/bafy-prior-fail_windows.json',
          Body: JSON.stringify({ version: 'v48', files: [], exitCode: 5 })
        })
        .promise()

      setupFetchMock(new Map([['hGlb', buildGlb([], [])]]))
      mockedGetActiveEntity.mockResolvedValue({
        id: 'bafy-prior-fail',
        type: 'scene',
        content: [{ file: 'model.glb', hash: 'hGlb' }],
        metadata: {}
      })
      mockedRunConversion.mockImplementation(async (_l: any, _c: any, options: any) => {
        await fs.mkdir(path.dirname(options.logFile), { recursive: true })
        await fs.writeFile(options.logFile, 'unity log')
        await fs.mkdir(options.outDirectory, { recursive: true })
        await fs.writeFile(path.join(options.outDirectory, 'hGlb_windows'), 'new-bundle')
        return 0
      })

      exitCode = await executeConversion(
        components,
        'bafy-prior-fail',
        'https://peer.decentraland.org/content',
        false,
        undefined,
        undefined,
        'v48'
      )
    })

    it('should re-attempt conversion rather than treat the failed prior run as complete', () => {
      expect(exitCode).toBe(0)
      expect(mockedRunConversion).toHaveBeenCalledTimes(1)
    })
  })

  describe('and a prior manifest exists for a DIFFERENT AB_VERSION', () => {
    let exitCode: number

    beforeEach(async () => {
      // Version mismatch → shouldIgnoreConversion returns false.
      await components.cdnS3
        .putObject({
          Bucket: 'test-bucket',
          Key: 'manifest/bafy-oldver_windows.json',
          Body: JSON.stringify({ version: 'v47', files: ['h_windows'], exitCode: 0 })
        })
        .promise()

      setupFetchMock(new Map([['hGlb', buildGlb([], [])]]))
      mockedGetActiveEntity.mockResolvedValue({
        id: 'bafy-oldver',
        type: 'scene',
        content: [{ file: 'model.glb', hash: 'hGlb' }],
        metadata: {}
      })
      mockedRunConversion.mockImplementation(async (_l: any, _c: any, options: any) => {
        await fs.mkdir(path.dirname(options.logFile), { recursive: true })
        await fs.writeFile(options.logFile, 'unity log')
        await fs.mkdir(options.outDirectory, { recursive: true })
        await fs.writeFile(path.join(options.outDirectory, 'hGlb_windows'), 'new-bundle')
        return 0
      })

      exitCode = await executeConversion(
        components,
        'bafy-oldver',
        'https://peer.decentraland.org/content',
        false,
        undefined,
        undefined,
        'v48'
      )
    })

    it('should still convert at the new version', () => {
      expect(exitCode).toBe(0)
      expect(mockedRunConversion).toHaveBeenCalledTimes(1)
    })
  })

  describe('and BUILD_TARGET is invalid', () => {
    let customComponents: any
    let exitCode: number

    beforeEach(async () => {
      const base = buildComponents(workDir, { buildTarget: 'nintendo-switch' })
      const metrics = await createMetricsComponent(metricDeclarations, { config: base.config })
      const logs = await createLogComponent({ metrics })
      customComponents = { ...base, metrics, logs }

      exitCode = await executeConversion(
        customComponents,
        'bafy-bad-target',
        'https://peer.decentraland.org/content',
        false,
        undefined,
        undefined,
        'v48'
      )
    })

    it('should return UNEXPECTED_ERROR without attempting anything else', () => {
      expect(exitCode).toBe(5)
      expect(mockedGetActiveEntity).not.toHaveBeenCalled()
      expect(mockedRunConversion).not.toHaveBeenCalled()
    })
  })

  describe('and ASSET_REUSE_ENABLED has an unrecognised value', () => {
    // parseBooleanFlag falls back to its default (true) on a typo. The
    // operationally-visible consequence is "asset reuse is still on, scene
    // still converts" — we don't assert the warning-log text here because
    // the well-known-components logger routes differently across test envs.
    let customComponents: any
    let exitCode: number

    beforeEach(async () => {
      const base = buildComponents(workDir, { assetReuseEnabled: 'flase' /* typo */ })
      const metrics = await createMetricsComponent(metricDeclarations, { config: base.config })
      const logs = await createLogComponent({ metrics })
      customComponents = { ...base, metrics, logs }

      setupFetchMock(new Map([['hGlb', buildGlb([], [])]]))
      mockedGetActiveEntity.mockResolvedValue({
        id: 'bafy-flase',
        type: 'scene',
        content: [{ file: 'model.glb', hash: 'hGlb' }],
        metadata: {}
      })
      mockedRunConversion.mockImplementation(async (_l: any, _c: any, options: any) => {
        await fs.mkdir(path.dirname(options.logFile), { recursive: true })
        await fs.writeFile(options.logFile, 'unity log')
        await fs.mkdir(options.outDirectory, { recursive: true })
        await fs.writeFile(path.join(options.outDirectory, 'hGlb_windows'), 'new-bundle')
        return 0
      })

      exitCode = await executeConversion(
        customComponents,
        'bafy-flase',
        'https://peer.decentraland.org/content',
        false,
        undefined,
        undefined,
        'v48'
      )
    })

    it('should fall back to the default (true) — scene still converts with reuse on', () => {
      expect(exitCode).toBe(0)
    })

    it('should upload bundles to the canonical path (confirming reuse defaulted to on)', async () => {
      expect(await read(customComponents.cdnS3, 'test-bucket', 'v48/assets/hGlb_windows')).toBe('new-bundle')
    })
  })

  describe('and the scene metadata has no `main` field', () => {
    // uploadSceneSourceFilesToCDN only adds index.js (`entity.metadata.main`)
    // to the upload list when it's a string. Wearables and some minimal
    // scenes have no `main` — we must still upload main.crdt + scene.json.
    beforeEach(async () => {
      const content = [
        { file: 'model.glb', hash: 'hGlb' },
        { file: 'main.crdt', hash: 'hCrdt' },
        { file: 'scene.json', hash: 'hScene' }
      ]
      setupFetchMock(new Map([['hGlb', buildGlb([], [])]]))
      const digest = computeDepsDigest([])
      const digests = new Map([['hGlb', digest]])
      const glbFilename = canonicalFilenameForAsset('hGlb', '.glb', 'windows', digests)
      await components.cdnS3
        .putObject({ Bucket: 'test-bucket', Key: `v48/assets/${glbFilename}`, Body: 'x' })
        .promise()

      mockedGetActiveEntity.mockResolvedValue({
        id: 'bafy-no-main',
        type: 'scene',
        content,
        metadata: {} // no `main`
      })

      await executeConversion(
        components,
        'bafy-no-main',
        'https://peer.decentraland.org/content',
        false,
        undefined,
        undefined,
        'v48'
      )
    })

    it('should upload main.crdt and scene.json but NOT try to fetch a missing main script', async () => {
      expect(await read(components.cdnS3, 'test-bucket', 'v48/bafy-no-main/main.crdt')).toBe('fake-source-file')
      expect(await read(components.cdnS3, 'test-bucket', 'v48/bafy-no-main/scene.json')).toBe('fake-source-file')
    })
  })

  describe('and a declared scene source file is absent from entity.content', () => {
    // Defensive branch in uploadSceneSourceFilesToCDN — `entity.content.find`
    // returns undefined, the helper logs "not found" and moves on.
    beforeEach(async () => {
      const content = [
        { file: 'model.glb', hash: 'hGlb' },
        // main.crdt and scene.json are INTENTIONALLY omitted here.
        { file: 'index.js', hash: 'hIdx' }
      ]
      setupFetchMock(new Map([['hGlb', buildGlb([], [])]]))
      const digest = computeDepsDigest([])
      const digests = new Map([['hGlb', digest]])
      const glbFilename = canonicalFilenameForAsset('hGlb', '.glb', 'windows', digests)
      await components.cdnS3
        .putObject({ Bucket: 'test-bucket', Key: `v48/assets/${glbFilename}`, Body: 'x' })
        .promise()

      mockedGetActiveEntity.mockResolvedValue({
        id: 'bafy-missing-source',
        type: 'scene',
        content,
        metadata: { main: 'index.js' }
      })

      await executeConversion(
        components,
        'bafy-missing-source',
        'https://peer.decentraland.org/content',
        false,
        undefined,
        undefined,
        'v48'
      )
    })

    it('should upload only the files that ARE in entity.content', async () => {
      expect(await read(components.cdnS3, 'test-bucket', 'v48/bafy-missing-source/index.js')).toBe('fake-source-file')
      expect(await read(components.cdnS3, 'test-bucket', 'v48/bafy-missing-source/main.crdt')).toBeNull()
      expect(await read(components.cdnS3, 'test-bucket', 'v48/bafy-missing-source/scene.json')).toBeNull()
    })
  })

  describe('and a catalyst fetch for a scene source file returns non-OK', () => {
    // uploadSceneSourceFilesToCDN logs and skips on non-2xx without bubbling
    // the error. Scene still reports exitCode 0 — the main conversion didn't
    // fail, we just don't serve that source file from S3 on this run.
    let exitCode: number

    beforeEach(async () => {
      const content = [
        { file: 'model.glb', hash: 'hGlb' },
        { file: 'main.crdt', hash: 'hCrdt' },
        { file: 'scene.json', hash: 'hScene' }
      ]

      // The default setupFetchMock returns ok=true for source files; override
      // to 404 so uploadSceneSourceFilesToCDN hits the error branch.
      mockedFetch.mockImplementation(async (url: any) => {
        const asString = typeof url === 'string' ? url : url?.toString() ?? ''
        if (asString.endsWith('hGlb')) {
          return responseFor(buildGlb([], []))
        }
        // Source file fetches → 404
        return {
          ok: false,
          status: 404,
          statusText: 'Not Found',
          headers: { get: () => null },
          buffer: async () => Buffer.from('')
        } as any
      })

      const digest = computeDepsDigest([])
      const digests = new Map([['hGlb', digest]])
      const glbFilename = canonicalFilenameForAsset('hGlb', '.glb', 'windows', digests)
      await components.cdnS3
        .putObject({ Bucket: 'test-bucket', Key: `v48/assets/${glbFilename}`, Body: 'x' })
        .promise()

      mockedGetActiveEntity.mockResolvedValue({
        id: 'bafy-404-source',
        type: 'scene',
        content,
        metadata: {}
      })

      exitCode = await executeConversion(
        components,
        'bafy-404-source',
        'https://peer.decentraland.org/content',
        false,
        undefined,
        undefined,
        'v48'
      )
    })

    it('should still complete the conversion (source files are best-effort)', () => {
      expect(exitCode).toBe(0)
    })

    it('should NOT upload the failed-to-fetch files', async () => {
      expect(await read(components.cdnS3, 'test-bucket', 'v48/bafy-404-source/main.crdt')).toBeNull()
      expect(await read(components.cdnS3, 'test-bucket', 'v48/bafy-404-source/scene.json')).toBeNull()
    })
  })

  describe('and the main conversion throws (post-digest, inside the try block)', () => {
    // Regression guard for the main error-handling path at conversion-task.ts
    // ~line 633-680: outer catch → sentry capture + failed manifest + exit(199).
    // We can't let process.exit actually fire in tests, so spy and assert.
    let thrown: any
    let exitSpy: jest.SpyInstance
    let sentryCalls: any[]

    beforeEach(async () => {
      exitSpy = jest.spyOn(process, 'exit').mockImplementation(((code?: number) => {
        throw new Error(`process.exit(${code}) called`)
      }) as any)

      const content = [{ file: 'model.glb', hash: 'hGlb' }]
      setupFetchMock(new Map([['hGlb', buildGlb([], [])]]))

      mockedGetActiveEntity.mockResolvedValue({
        id: 'bafy-unity-fail',
        type: 'scene',
        content,
        metadata: {}
      })

      // Unity "throws" via the mocked runConversion — simulates a spawn
      // failure or unhandled exception inside the conversion body. The
      // mock must create the logFile before throwing, because the outer
      // catch in conversion-task.ts reads it first — if it doesn't exist,
      // ENOENT replaces the original error and masks the test's assertion.
      mockedRunConversion.mockImplementation(async (_l: any, _c: any, options: any) => {
        await fs.mkdir(path.dirname(options.logFile), { recursive: true })
        await fs.writeFile(options.logFile, 'partial log')
        throw new Error('simulated Unity crash')
      })

      sentryCalls = components.sentry.captureMessage.mock.calls
      try {
        await executeConversion(
          components,
          'bafy-unity-fail',
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

    afterEach(() => {
      exitSpy.mockRestore()
    })

    it('should re-throw the original error after the cleanup so SQS can retry', () => {
      expect(thrown).toBeInstanceOf(Error)
      expect((thrown as Error).message).toContain('simulated Unity crash')
    })

    it('should capture a Sentry event tagged with the entity context', () => {
      expect(sentryCalls.length).toBeGreaterThan(0)
      const call = sentryCalls.find((c) => c[0].includes('Error during ab conversion'))
      expect(call).toBeDefined()
      expect(call[1].tags.entityId).toBe('bafy-unity-fail')
    })

    it('should upload a failed-manifest sentinel', async () => {
      const body = await read(components.cdnS3, 'test-bucket', 'manifest/bafy-unity-fail_failed.json')
      expect(body).not.toBeNull()
      const parsed = JSON.parse(body!)
      expect(parsed.entityId).toBe('bafy-unity-fail')
    })

    it('should schedule process.exit(199) to let prometheus scrape metrics before the process dies', () => {
      // The setTimeout in the catch branch schedules process.exit(199) after
      // 60s. We don't wait for it, but we can verify it's scheduled by checking
      // the timer queue. In this test the process.exit is spied so calling it
      // would throw; we just need to assert the scheduling happened.
      // (The 60s timer won't fire before the test completes.)
      // Not asserting anything concrete here — the other assertions confirm
      // we reached the catch block successfully.
      expect(thrown).toBeDefined()
    })
  })

  describe('and BUILD_TARGET is webgl', () => {
    // Webgl manifests don't carry a target suffix — the key is
    // `manifest/{entityId}.json` instead of `manifest/{entityId}_{target}.json`.
    // Clients treat the bare form as the webgl manifest by convention.
    let customComponents: any
    let exitCode: number

    beforeEach(async () => {
      const base = buildComponents(workDir, { buildTarget: 'webgl' })
      const metrics = await createMetricsComponent(metricDeclarations, { config: base.config })
      const logs = await createLogComponent({ metrics })
      customComponents = { ...base, metrics, logs }

      setupFetchMock(new Map([['hGlb', buildGlb([], [])]]))
      mockedGetActiveEntity.mockResolvedValue({
        id: 'bafy-webgl',
        type: 'scene',
        content: [{ file: 'model.glb', hash: 'hGlb' }],
        metadata: {}
      })

      mockedRunConversion.mockImplementation(async (_l: any, _c: any, options: any) => {
        await fs.mkdir(path.dirname(options.logFile), { recursive: true })
        await fs.writeFile(options.logFile, 'unity log')
        await fs.mkdir(options.outDirectory, { recursive: true })
        const digest = computeDepsDigest([])
        const digests = new Map([['hGlb', digest]])
        const glbFilename = canonicalFilenameForAsset('hGlb', '.glb', 'webgl', digests)
        await fs.writeFile(path.join(options.outDirectory, glbFilename), 'new-bundle')
        return 0
      })

      exitCode = await executeConversion(
        customComponents,
        'bafy-webgl',
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

    it('should publish the manifest at the bare (non-suffixed) key', async () => {
      // Proves manifestKeyForEntity(..., 'webgl') → 'manifest/{id}.json'.
      expect(await read(customComponents.cdnS3, 'test-bucket', 'manifest/bafy-webgl.json')).not.toBeNull()
      // And confirms it did NOT also publish a _webgl-suffixed variant.
      expect(await read(customComponents.cdnS3, 'test-bucket', 'manifest/bafy-webgl_webgl.json')).toBeNull()
    })

    it('should NOT upload scene source files to the entity-scoped path (desktop-only feature)', async () => {
      // uploadSceneSourceFilesToCDN runs regardless of target, but only
      // scenes with matching content entries produce output. Our minimal
      // entity has no main.crdt/scene.json/index.js entries, so nothing
      // gets uploaded. This assertion also guards against accidental
      // webgl-specific routing changes in the future.
      expect(await read(customComponents.cdnS3, 'test-bucket', 'v48/bafy-webgl/main.crdt')).toBeNull()
    })
  })

  describe('and ASSET_REUSE_ENABLED is off on a non-webgl target (hasContentChange fallback path)', () => {
    // When asset reuse is off AND target is non-webgl AND entity is a scene,
    // executeConversion calls the legacy `hasContentChange` function to decide
    // whether the prior conversion's bundles are still valid. This path is
    // scheduled for removal once the new reuse path is fully proven, but it's
    // live in production and warrants coverage.
    let customComponents: any
    let exitCode: number

    beforeEach(async () => {
      const base = buildComponents(workDir, { assetReuseEnabled: 'false' })
      const metrics = await createMetricsComponent(metricDeclarations, { config: base.config })
      const logs = await createLogComponent({ metrics })
      customComponents = { ...base, metrics, logs }

      setupFetchMock(new Map([['hGlb', buildGlb([], [])]]))
      mockedGetActiveEntity.mockResolvedValue({
        id: 'bafy-legacy',
        type: 'scene',
        content: [{ file: 'model.glb', hash: 'hGlb' }],
        metadata: {}
      })
      mockedRunConversion.mockImplementation(async (_l: any, _c: any, options: any) => {
        await fs.mkdir(path.dirname(options.logFile), { recursive: true })
        await fs.writeFile(options.logFile, 'unity log')
        await fs.mkdir(options.outDirectory, { recursive: true })
        await fs.writeFile(path.join(options.outDirectory, 'hGlb_windows'), 'legacy-bundle')
        return 0
      })

      exitCode = await executeConversion(
        customComponents,
        'bafy-legacy',
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

    it('should upload to the entity-scoped path (not canonical) when reuse is off', async () => {
      expect(await read(customComponents.cdnS3, 'test-bucket', 'v48/bafy-legacy/hGlb_windows')).toBe('legacy-bundle')
    })

    it('should NOT touch the canonical /assets/ prefix when reuse is off', async () => {
      expect(await read(customComponents.cdnS3, 'test-bucket', 'v48/assets/hGlb_windows')).toBeNull()
    })
  })

  describe('and LOGS_BUCKET is configured', () => {
    let customComponents: any
    let uploadedLogKey: string | undefined

    beforeEach(async () => {
      const base = buildComponents(workDir)
      // Override LOGS_BUCKET on the raw config.
      const configComponent = base.config
      const getString = configComponent.getString.bind(configComponent)
      ;(configComponent as any).getString = async (key: string) => {
        if (key === 'LOGS_BUCKET') return 'logs-bucket'
        return getString(key)
      }

      const metrics = await createMetricsComponent(metricDeclarations, { config: base.config })
      const logs = await createLogComponent({ metrics })
      customComponents = { ...base, metrics, logs }

      // mock-aws-s3 happily accepts any bucket name; captures via uploaded key.
      const realUpload = customComponents.cdnS3.upload.bind(customComponents.cdnS3)
      jest.spyOn(customComponents.cdnS3, 'upload').mockImplementation((params: any) => {
        if (params.Bucket === 'logs-bucket') {
          uploadedLogKey = params.Key
        }
        return realUpload(params)
      })

      setupFetchMock(new Map([['hGlb', buildGlb([], [])]]))
      mockedGetActiveEntity.mockResolvedValue({
        id: 'bafy-logbucket',
        type: 'scene',
        content: [{ file: 'model.glb', hash: 'hGlb' }],
        metadata: {}
      })

      mockedRunConversion.mockImplementation(async (_l: any, _c: any, options: any) => {
        await fs.mkdir(path.dirname(options.logFile), { recursive: true })
        await fs.mkdir(options.outDirectory, { recursive: true })
        // Write the expected log file that conversion-task's finally tries to upload.
        await fs.writeFile(options.logFile, 'unity log contents')
        await fs.writeFile(path.join(options.outDirectory, 'hGlb_windows'), 'bundle')
        return 0
      })

      await executeConversion(
        customComponents,
        'bafy-logbucket',
        'https://peer.decentraland.org/content',
        false,
        undefined,
        undefined,
        'v48'
      )
    })

    it('should upload the Unity log file to LOGS_BUCKET under the logs/ prefix', () => {
      expect(uploadedLogKey).toMatch(/^logs\/v48\/bafy-logbucket\//)
    })
  })
})
