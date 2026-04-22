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

  describe('when none of the scrub targets exist', () => {
    let resolvedValue: void

    beforeEach(async () => {
      resolvedValue = await scrubUnityProjectState(projectPath, logger, loggerMetadata)
    })

    it('should resolve without throwing', () => {
      expect(resolvedValue).toBeUndefined()
    })

    it('should not log any warning since there is nothing stuck', () => {
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

    it('should not log any warning on the happy path', () => {
      expect(logger.warn).not.toHaveBeenCalled()
    })
  })

  describe('when an unrelated directory also lives under the project path', () => {
    let unrelatedFile: string

    beforeEach(async () => {
      unrelatedFile = path.join(projectPath, 'Assets', 'AssetBundleConverter', 'keep.cs')
      await fs.mkdir(path.dirname(unrelatedFile), { recursive: true })
      await fs.writeFile(unrelatedFile, 'x')

      await scrubUnityProjectState(projectPath, logger, loggerMetadata)
    })

    it('should leave the unrelated file intact (scrub must not over-reach)', async () => {
      await expect(fs.stat(unrelatedFile)).resolves.toBeDefined()
    })
  })

  describe('when one scrub target fails with EBUSY but the others would succeed', () => {
    let rimrafSpy: jest.SpyInstance
    let freshScrub: typeof scrubUnityProjectState

    beforeEach(async () => {
      jest.resetModules()
      rimrafSpy = jest.spyOn(require('rimraf'), 'rimraf').mockImplementation((async (target: string) => {
        if (target.endsWith('Library')) {
          throw new Error('EBUSY: resource busy or locked')
        }
      }) as any)
      freshScrub = require('../../src/logic/scrub-unity-project-state').scrubUnityProjectState
    })

    afterEach(() => {
      rimrafSpy.mockRestore()
    })

    describe('and the scrub runs to completion', () => {
      let resolvedValue: void

      beforeEach(async () => {
        resolvedValue = await freshScrub(projectPath, logger, loggerMetadata)
      })

      it('should not re-throw the underlying EBUSY error', () => {
        expect(resolvedValue).toBeUndefined()
      })

      it('should log a warning that names the failed target', () => {
        expect(logger.warn).toHaveBeenCalledWith(
          expect.stringContaining('Unity project scrub failed'),
          expect.any(Object)
        )
      })

      it('should attempt rimraf on all three targets even though Library threw', () => {
        expect(rimrafSpy).toHaveBeenCalledTimes(3)
      })
    })
  })
})
