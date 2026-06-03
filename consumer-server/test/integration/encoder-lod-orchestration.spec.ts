/* eslint-disable @typescript-eslint/no-var-requires */
// Full encoder-LOD orchestration through the REAL consumer-server components,
// using the locally-built @dcl/asset-bundle-encoder package — no Unity.
//
// Exercises executeLODConversion's encoder path end-to-end:
//   createAssetBundleEncoderComponent.start() → loads bake artifacts + native module
//   executeLODConversion (ENCODER_LODS_ENABLED=true, FALLBACK=false)
//     → fetches each LOD source FBX over HTTP
//     → assetBundleEncoder.encodeLod() (native encode_lod over the napi boundary)
//     → writes {level}/{entityId}_{level}_windows into outDirectory
//     → uploadDir uploads to (mock) S3 under LOD/{level}/…
//
// Prereq: the package is symlinked into node_modules + a real LOD source FBX
// exists at FBX_DIR/{entity}_{level}.fbx (downloaded from the lods bucket).

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
import { executeLODConversion } from '../../src/logic/conversion-task'

const MockAws = require('mock-aws-s3')

const ENTITY = 'bafkreid4vfyjkovvx33ttgdnsycbyvbbyj76o75ijvfmklhbe3cyh6elpm'
const FBX_DIR = '/tmp/lodfbx'
const FIXTURE = path.join(path.dirname(require.resolve('@dcl/asset-bundle-encoder')), 'baked-fixtures/typetrees/6000.2.6f2.bin')

describe('when running a scene-LOD conversion through the encoder (no Unity)', () => {
  let server: http.Server
  let baseUrl: string
  let bucketDir: string
  let unityCalled: boolean
  let exitCode: number
  const outDirectory = `/tmp/lods_contents/entity_${ENTITY}`

  beforeAll(async () => {
    const fbx0 = await fs.readFile(`${FBX_DIR}/${ENTITY}_0.fbx`)
    const fbx1 = await fs.readFile(`${FBX_DIR}/${ENTITY}_1.fbx`)
    bucketDir = await fs.mkdtemp(path.join(os.tmpdir(), 'enc-lod-bucket-'))

    // Local LOD source server: GET /{entity}_{level}.fbx → FBX bytes.
    server = http.createServer((req, res) => {
      const name = (req.url ?? '').replace(/^\//, '').split('?')[0]
      if (name === `${ENTITY}_0.fbx`) return res.writeHead(200).end(fbx0)
      if (name === `${ENTITY}_1.fbx`) return res.writeHead(200).end(fbx1)
      res.writeHead(404).end()
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`

    const config = createConfigComponent({
      BUILD_TARGET: 'windows',
      AB_VERSION: 'v49',
      BAKE_VERSION: 'testbake',
      AB_BAKE_BUCKET: 'test-bucket',
      ENCODER_ENABLED: 'true',
      ENCODER_LODS_ENABLED: 'true',
      ENCODER_FALLBACK_TO_UNITY: 'false',
      UNITY_PATH: '/fake/unity',
      PROJECT_PATH: '/fake/project'
    })
    MockAws.config.basePath = bucketDir
    const cdnS3 = new MockAws.S3({ params: { Bucket: 'test-bucket' } })

    const prefix = 'testbake/windows'
    await cdnS3.putObject({ Bucket: 'test-bucket', Key: `${prefix}/typetrees.bin`, Body: await fs.readFile(FIXTURE) }).promise()
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
    const assetBundleEncoder = await createAssetBundleEncoderComponent({ config, logs, metrics, cdnS3 } as any)
    await (assetBundleEncoder as any).start()

    unityCalled = false
    const unityRunner = {
      runConversion: async () => 0,
      runLodsConversion: async () => {
        unityCalled = true
        throw new Error('Unity must NOT be called on the encoder LOD path')
      }
    } as any
    const scenes = { getCdnBucket: async () => 'test-bucket' } as any

    exitCode = await executeLODConversion(
      { logs, metrics, config, cdnS3, unityRunner, scenes, assetBundleEncoder } as any,
      ENTITY,
      [`${baseUrl}${ENTITY}_0.fbx`, `${baseUrl}${ENTITY}_1.fbx`],
      'v49'
    )
  }, 180000)

  afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()))
  })

  it('should complete successfully (exit code 0)', () => {
    expect(exitCode).toBe(0)
  })

  it('should not invoke the Unity LOD runner', () => {
    expect(unityCalled).toBe(false)
  })

  it('should upload LOD0 + LOD1 bundles under the production LOD path', async () => {
    const keys: string[] = []
    async function walk(dir: string, rel = '') {
      for (const e of await fs.readdir(dir, { withFileTypes: true })) {
        const r = rel ? `${rel}/${e.name}` : e.name
        if (e.isDirectory()) await walk(path.join(dir, e.name), r)
        else keys.push(r)
      }
    }
    await walk(bucketDir)
    // uploadDir writes brotli + uncompressed variants under LOD/{level}/…
    expect(keys.some((k) => k.includes(`LOD/0/${ENTITY}_0_windows`))).toBe(true)
    expect(keys.some((k) => k.includes(`LOD/1/${ENTITY}_1_windows`))).toBe(true)
  })

  it('should upload valid UnityFS LOD bundles', async () => {
    // Find the uncompressed LOD0 bundle and check the UnityFS magic.
    const found: string[] = []
    async function walk(dir: string) {
      for (const e of await fs.readdir(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name)
        if (e.isDirectory()) await walk(p)
        else if (p.includes(`LOD/0/${ENTITY}_0_windows`) && !p.endsWith('.br')) found.push(p)
      }
    }
    await walk(bucketDir)
    expect(found.length).toBeGreaterThan(0)
    const bytes = await fs.readFile(found[0])
    expect(bytes.subarray(0, 7).toString('latin1')).toBe('UnityFS')
  })
})
