// End-to-end proof of `executeLODConversion`. Not exercised by the scene
// integration spec (scenes and LODs share no code below executeConversion),
// so without this file the LOD path is 0% covered.

import * as fs from 'fs/promises'
import * as os from 'os'
import * as path from 'path'
import { rimraf } from 'rimraf'

import { createConfigComponent } from '@well-known-components/env-config-provider'
import { createLogComponent } from '@well-known-components/logger'
import { createMetricsComponent } from '@well-known-components/metrics'
import { metricDeclarations } from '../../src/metrics'

jest.mock('../../src/logic/run-conversion', () => ({
  runConversion: jest.fn(),
  runLodsConversion: jest.fn()
}))

// eslint-disable-next-line @typescript-eslint/no-var-requires
const MockAws = require('mock-aws-s3')
import { runLodsConversion } from '../../src/logic/run-conversion'
import { executeLODConversion } from '../../src/logic/conversion-task'

const mockedRunLodsConversion = runLodsConversion as jest.Mock

type Params = {
  buildTarget?: string
  logsBucket?: string
}

function buildComponents(bucketBasePath: string, params: Params = {}) {
  const config = createConfigComponent({
    UNITY_PATH: '/fake/unity',
    PROJECT_PATH: '/fake/project',
    BUILD_TARGET: params.buildTarget ?? 'windows',
    CDN_BUCKET: 'test-bucket',
    LOGS_BUCKET: params.logsBucket ?? ''
  })

  MockAws.config.basePath = bucketBasePath
  const cdnS3 = new MockAws.S3({ params: { Bucket: 'test-bucket' } })
  return { config, cdnS3 }
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

describe('when executing a LOD conversion', () => {
  let workDir: string
  let components: any

  beforeEach(async () => {
    workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'exec-lod-test-'))
    const base = buildComponents(workDir)
    const metrics = await createMetricsComponent(metricDeclarations, { config: base.config })
    const logs = await createLogComponent({ metrics })
    components = { ...base, metrics, logs }
    jest.clearAllMocks()
  })

  afterEach(async () => {
    await rimraf(workDir, { maxRetries: 3 })
  })

  describe('and Unity writes LOD bundle files and exits 0', () => {
    let exitCode: number
    let uploadedKeys: string[]

    beforeEach(async () => {
      uploadedKeys = []
      const realUpload = components.cdnS3.upload.bind(components.cdnS3)
      jest.spyOn(components.cdnS3, 'upload').mockImplementation((params: any) => {
        uploadedKeys.push(params.Key)
        return realUpload(params)
      })

      mockedRunLodsConversion.mockImplementation(async (_l: any, _c: any, options: any) => {
        await fs.mkdir(path.dirname(options.logFile), { recursive: true })
        await fs.mkdir(options.outDirectory, { recursive: true })
        await fs.writeFile(options.logFile, 'lod-unity-log')
        await fs.writeFile(path.join(options.outDirectory, 'bundle_A'), 'lod-bundle-a')
        await fs.writeFile(path.join(options.outDirectory, 'bundle_B'), 'lod-bundle-b')
        return 0
      })

      exitCode = await executeLODConversion(
        components,
        'bafy-lod-entity',
        ['https://cdn.example.com/lod1', 'https://cdn.example.com/lod2'],
        'v48'
      )
    })

    it('should return the Unity exit code (0)', () => {
      expect(exitCode).toBe(0)
    })

    it('should upload each generated bundle file under the LOD/ prefix', () => {
      // Two bundle files → two uploads under LOD/.
      const lodUploads = uploadedKeys.filter((k) => k.startsWith('LOD/'))
      expect(lodUploads.length).toBeGreaterThanOrEqual(2)
    })

    it('should pass the LOD URL list to the Unity runner', () => {
      const passed = mockedRunLodsConversion.mock.calls[0][2]
      expect(passed.lods).toEqual(['https://cdn.example.com/lod1', 'https://cdn.example.com/lod2'])
    })
  })

  describe('and the build target is invalid', () => {
    let customComponents: any
    let exitCode: number

    beforeEach(async () => {
      const base = buildComponents(workDir, { buildTarget: 'game-cube' })
      const metrics = await createMetricsComponent(metricDeclarations, { config: base.config })
      const logs = await createLogComponent({ metrics })
      customComponents = { ...base, metrics, logs }

      exitCode = await executeLODConversion(customComponents, 'bafy-bad-target', ['http://x/lod1'], 'v48')
    })

    it('should return UNEXPECTED_ERROR without invoking Unity', () => {
      expect(exitCode).toBe(5)
      expect(mockedRunLodsConversion).not.toHaveBeenCalled()
    })
  })

  describe('and Unity exits 0 but produces zero output files', () => {
    let exitCode: number

    beforeEach(async () => {
      mockedRunLodsConversion.mockImplementation(async (_l: any, _c: any, options: any) => {
        await fs.mkdir(path.dirname(options.logFile), { recursive: true })
        await fs.mkdir(options.outDirectory, { recursive: true })
        await fs.writeFile(options.logFile, 'empty log')
        // Intentionally write NO bundle files. The empty-conversion guard
        // should fire even though the subprocess "succeeded".
        return 0
      })

      exitCode = await executeLODConversion(components, 'bafy-empty-lod', ['http://x/lod1'], 'v48')
    })

    it('should return UNEXPECTED_ERROR rather than treat empty output as success', () => {
      expect(exitCode).toBe(5)
    })
  })

  describe('and Unity throws', () => {
    let thrown: any
    let exitSpy: jest.SpyInstance

    beforeEach(async () => {
      exitSpy = jest.spyOn(process, 'exit').mockImplementation(((code?: number) => {
        throw new Error(`process.exit(${code}) called`)
      }) as any)

      mockedRunLodsConversion.mockImplementation(async (_l: any, _c: any, options: any) => {
        await fs.mkdir(path.dirname(options.logFile), { recursive: true })
        await fs.mkdir(options.outDirectory, { recursive: true })
        await fs.writeFile(options.logFile, 'crashed')
        throw new Error('simulated Unity LOD crash')
      })

      try {
        await executeLODConversion(components, 'bafy-crash-lod', ['http://x/lod1'], 'v48')
      } catch (err) {
        thrown = err
      }
    })

    afterEach(() => {
      exitSpy.mockRestore()
    })

    it('should re-throw the original error', () => {
      expect(thrown).toBeInstanceOf(Error)
      expect((thrown as Error).message).toContain('simulated Unity LOD crash')
    })
  })

  describe('and LOGS_BUCKET is configured', () => {
    let customComponents: any
    let uploadedLogKey: string | undefined

    beforeEach(async () => {
      const base = buildComponents(workDir, { logsBucket: 'lod-logs-bucket' })
      const metrics = await createMetricsComponent(metricDeclarations, { config: base.config })
      const logs = await createLogComponent({ metrics })
      customComponents = { ...base, metrics, logs }

      const realUpload = customComponents.cdnS3.upload.bind(customComponents.cdnS3)
      jest.spyOn(customComponents.cdnS3, 'upload').mockImplementation((params: any) => {
        if (params.Bucket === 'lod-logs-bucket') uploadedLogKey = params.Key
        return realUpload(params)
      })

      mockedRunLodsConversion.mockImplementation(async (_l: any, _c: any, options: any) => {
        await fs.mkdir(path.dirname(options.logFile), { recursive: true })
        await fs.mkdir(options.outDirectory, { recursive: true })
        await fs.writeFile(options.logFile, 'lod unity log contents')
        await fs.writeFile(path.join(options.outDirectory, 'lod_output'), 'lod-output-bytes')
        return 0
      })

      await executeLODConversion(customComponents, 'bafy-lod-logs', ['http://x/lod1'], 'v48')
    })

    it('should upload the Unity log to the LOD-specific logs/lods/ prefix', () => {
      expect(uploadedLogKey).toMatch(/^logs\/lods\/v48\/bafy-lod-logs\//)
    })
  })
})
