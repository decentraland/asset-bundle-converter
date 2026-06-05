/* eslint-disable @typescript-eslint/no-var-requires */
// Full encoder orchestration through the REAL consumer-server components,
// using the locally-built @dcl/asset-bundle-encoder package — no Unity.
//
// Exercises the production wiring end-to-end:
//   createAssetBundleEncoderComponent.start()  → loads bake artifacts from
//       (mock) S3 + require('@dcl/asset-bundle-encoder').createEncoder()
//   createSceneConverter.convert()             → routes to the encoder
//       (ENCODER_ENABLED=true, FALLBACK=false), calls native.encode(), writes
//       the produced bundle bytes into outDirectory in the on-disk shape the
//       rest of conversion-task.ts (manifest + uploadDir) expects.
//
// The encoder fetches scene content via its own Rust HTTP client, so a JS fetch
// mock won't do — we stand up a real local HTTP "catalyst" serving a cached
// corpus glb by hash. Prereq: the package is symlinked into node_modules and a
// glb exists at GLB_PATH (see the run script).

import * as fs from 'fs/promises'
import * as os from 'os'
import * as path from 'path'
import * as http from 'http'
import type { AddressInfo } from 'net'

import { createConfigComponent } from '@well-known-components/env-config-provider'
import { createLogComponent } from '@well-known-components/logger'
import { createMetricsComponent } from '@well-known-components/metrics'
import { metricDeclarations } from '../../src/metrics'
import { createAssetBundleEncoderComponent } from '../../src/adapters/asset-bundle-encoder'
import { createSceneConverter } from '../../src/logic/scene-converter'

const MockAws = require('mock-aws-s3')

// A cached corpus scene glb (embedded textures, no Draco) + its corpus digest.
const GLB_HASH = 'bafkreihe6kzclzofufhfk27f5cx4pgfsfot33eayzvl67qrg5czo56lhfy'
const GLB_PATH = `/tmp/glbsrc/${GLB_HASH}.glb`
const DEPS_DIGEST = '4f53cda18c2baa0c0354bb5f9a3ecbe5'
const FIXTURE = path.join(
  path.dirname(require.resolve('@dcl/asset-bundle-encoder')),
  'baked-fixtures/typetrees/6000.2.6f2.bin'
)

describe('when running a full scene conversion through the encoder (no Unity)', () => {
  let workDir: string
  let bucketDir: string
  let server: http.Server
  let baseUrl: string
  let glb: Buffer
  let result: Awaited<ReturnType<Awaited<ReturnType<typeof createSceneConverter>>['convert']>>
  let outDir: string
  let unityCalled: boolean

  beforeAll(async () => {
    glb = await fs.readFile(GLB_PATH)
    workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'enc-orch-'))
    bucketDir = await fs.mkdtemp(path.join(os.tmpdir(), 'enc-orch-bucket-'))
    outDir = path.join(workDir, `entity_${GLB_HASH}`)

    // Local "catalyst": GET /{hash} → glb bytes (the encoder's Rust client).
    server = http.createServer((req, res) => {
      const hash = (req.url ?? '').replace(/^\//, '').split('?')[0]
      if (hash === GLB_HASH) {
        res.writeHead(200)
        res.end(glb)
      } else {
        res.writeHead(404)
        res.end()
      }
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`

    const config = createConfigComponent({
      BUILD_TARGET: 'windows',
      AB_VERSION: 'v49',
      BAKE_VERSION: 'testbake',
      AB_BAKE_BUCKET: 'test-bucket',
      CDN_BUCKET: 'test-bucket',
      ENCODER_ENABLED: 'true',
      ENCODER_FALLBACK_TO_UNITY: 'false',
      UNITY_PATH: '/fake/unity',
      PROJECT_PATH: '/fake/project'
    })
    MockAws.config.basePath = bucketDir
    const cdnS3 = new MockAws.S3({ params: { Bucket: 'test-bucket' } })

    // Pre-populate the bake artifacts the adapter's start() loads from S3.
    const prefix = 'testbake/windows'
    await cdnS3
      .putObject({ Bucket: 'test-bucket', Key: `${prefix}/typetrees.bin`, Body: await fs.readFile(FIXTURE) })
      .promise()
    await cdnS3.putObject({ Bucket: 'test-bucket', Key: `${prefix}/shader-guids.json`, Body: Buffer.from('{}') }).promise()
    await cdnS3
      .putObject({
        Bucket: 'test-bucket',
        Key: `${prefix}/bake-info.json`,
        Body: Buffer.from(JSON.stringify({ unity_version: '6000.2.6f2', bake_version: 'testbake', bake_date: '1970-01-01' }))
      })
      .promise()

    const metrics = await createMetricsComponent(metricDeclarations, { config })
    const logs = await createLogComponent({ metrics })
    const sentry = { captureException: () => undefined, captureMessage: () => undefined } as any

    const assetBundleEncoder = await createAssetBundleEncoderComponent({ config, logs, metrics, cdnS3 } as any)
    await (assetBundleEncoder as any).start()

    // Unity runner that fails the test if invoked — proves the encoder path ran.
    unityCalled = false
    const unityRunner = {
      runConversion: async () => {
        unityCalled = true
        throw new Error('Unity must NOT be called on the encoder path')
      },
      runLodsConversion: async () => 0
    } as any

    const sceneConverter = await createSceneConverter({ config, logs, metrics, unityRunner, assetBundleEncoder, sentry })

    result = await sceneConverter.convert({
      logFile: path.join(workDir, 'log.txt'),
      outDirectory: outDir,
      entityId: GLB_HASH,
      entityType: 'scene',
      contentServerUrl: baseUrl,
      unityPath: '/fake/unity',
      projectPath: '/fake/project',
      timeout: 60000,
      unityBuildTarget: 'StandaloneWindows64',
      animation: undefined,
      doISS: undefined,
      catalystBaseUrl: baseUrl,
      contentMap: [{ file: 'model.glb', hash: GLB_HASH }],
      depsDigestByHash: new Map([[GLB_HASH, DEPS_DIGEST]]),
      cachedHashes: [],
      skippedHashes: [],
      shaderType: 'dcl'
    } as any)
  }, 120000)

  afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()))
  })

  it('should route to the encoder engine (not Unity)', () => {
    expect(result.engine).toBe('encoder')
  })

  it('should not invoke the Unity runner', () => {
    expect(unityCalled).toBe(false)
  })

  it('should write a bundle into the out directory named like production', async () => {
    const files = await fs.readdir(outDir)
    expect(files).toContain(`${GLB_HASH}_${DEPS_DIGEST}_windows`)
  })

  it('should produce a valid UnityFS bundle on disk', async () => {
    const bundle = await fs.readFile(path.join(outDir, `${GLB_HASH}_${DEPS_DIGEST}_windows`))
    expect(bundle.subarray(0, 7).toString('latin1')).toBe('UnityFS')
  })
})
