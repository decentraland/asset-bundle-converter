import * as fs from 'fs/promises'
import * as path from 'path'
import * as os from 'os'
import { ILoggerComponent } from '@well-known-components/interfaces'

import { scrubUnityProjectState } from '../../src/logic/scrub-unity-project-state'

type LoggerMock = ILoggerComponent.ILogger & {
  info: jest.Mock
  warn: jest.Mock
  error: jest.Mock
  debug: jest.Mock
  log: jest.Mock
}

function createLoggerMock(): LoggerMock {
  return {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
    log: jest.fn()
  } as LoggerMock
}

describe('scrubUnityProjectState', () => {
  let projectPath: string
  let logger: LoggerMock
  let loggerMetadata: Record<string, unknown>

  beforeEach(async () => {
    projectPath = await fs.mkdtemp(path.join(os.tmpdir(), 'scrub-test-'))
    logger = createLoggerMock()
    loggerMetadata = { entityId: 'bafy-test-entity' }
  })

  afterEach(async () => {
    await fs.rm(projectPath, { recursive: true, force: true })
    jest.clearAllMocks()
  })

  describe('when the scrub targets do not exist', () => {
    it('should complete without throwing', async () => {
      await expect(scrubUnityProjectState(projectPath, logger, loggerMetadata)).resolves.toBeUndefined()
    })

    it('should not log any warnings', async () => {
      await scrubUnityProjectState(projectPath, logger, loggerMetadata)
      expect(logger.warn).not.toHaveBeenCalled()
    })
  })

  describe('when all scrub targets exist with nested content', () => {
    beforeEach(async () => {
      await fs.mkdir(path.join(projectPath, 'Library', 'ScriptAssemblies'), { recursive: true })
      await fs.writeFile(path.join(projectPath, 'Library', 'ScriptAssemblies', 'stale.dll'), 'x')
      await fs.mkdir(path.join(projectPath, 'Assets', '_Downloaded', 'bafy-old'), { recursive: true })
      await fs.writeFile(path.join(projectPath, 'Assets', '_Downloaded', 'bafy-old', 'file.png'), 'x')
      await fs.mkdir(path.join(projectPath, 'Assets', '_SceneManifest'), { recursive: true })
      await fs.writeFile(path.join(projectPath, 'Assets', '_SceneManifest', 'scene.json'), '{}')

      await scrubUnityProjectState(projectPath, logger, loggerMetadata)
    })

    it('should remove the Library directory', async () => {
      await expect(fs.stat(path.join(projectPath, 'Library'))).rejects.toThrow(/ENOENT/)
    })

    it('should remove the Assets/_Downloaded directory', async () => {
      await expect(fs.stat(path.join(projectPath, 'Assets', '_Downloaded'))).rejects.toThrow(/ENOENT/)
    })

    it('should remove the Assets/_SceneManifest directory', async () => {
      await expect(fs.stat(path.join(projectPath, 'Assets', '_SceneManifest'))).rejects.toThrow(/ENOENT/)
    })

    it('should leave unrelated Assets subdirectories intact', async () => {
      // Also seed and verify — prevents regressions where the scrub over-reaches.
      await fs.mkdir(path.join(projectPath, 'Assets', 'AssetBundleConverter'), { recursive: true })
      await fs.writeFile(path.join(projectPath, 'Assets', 'AssetBundleConverter', 'keep.cs'), 'x')
      await scrubUnityProjectState(projectPath, logger, loggerMetadata)
      await expect(
        fs.stat(path.join(projectPath, 'Assets', 'AssetBundleConverter', 'keep.cs'))
      ).resolves.toBeDefined()
    })

    it('should not log any warnings on the happy path', () => {
      expect(logger.warn).not.toHaveBeenCalled()
    })
  })

  describe('when one scrub target fails', () => {
    let rimrafSpy: jest.SpyInstance

    beforeEach(async () => {
      jest.resetModules()
      rimrafSpy = jest.spyOn(require('rimraf'), 'rimraf').mockImplementation((async (target: string) => {
        if (target.endsWith('Library')) {
          throw new Error('EBUSY: resource busy or locked')
        }
      }) as any)
    })

    afterEach(() => {
      rimrafSpy.mockRestore()
    })

    it('should log a warning for the failed target', async () => {
      const { scrubUnityProjectState: freshScrub } = require('../../src/logic/scrub-unity-project-state')
      await freshScrub(projectPath, logger, loggerMetadata)
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining('Pre-job scrub failed'),
        expect.any(Object)
      )
    })

    it('should continue and clean the remaining targets', async () => {
      const { scrubUnityProjectState: freshScrub } = require('../../src/logic/scrub-unity-project-state')
      await freshScrub(projectPath, logger, loggerMetadata)
      // rimraf was called for all three targets even though Library threw.
      expect(rimrafSpy).toHaveBeenCalledTimes(3)
    })

    it('should not re-throw the underlying error', async () => {
      const { scrubUnityProjectState: freshScrub } = require('../../src/logic/scrub-unity-project-state')
      await expect(freshScrub(projectPath, logger, loggerMetadata)).resolves.toBeUndefined()
    })
  })
})
