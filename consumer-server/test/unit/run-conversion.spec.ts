// Targeted coverage of `runConversion`'s CLI-argument construction and the
// deps-digests.json sidecar file lifecycle. Integration tests (`execute-
// conversion.spec.ts`) jest.mock the entire run-conversion module, so nothing
// there exercises these lines — a silent bug (wrong path, missing argv entry,
// unlink-before-spawn ordering) would ship undetected.
//
// Strategy: mock `child_process.spawn` so `spawn()` returns a stub that emits
// `close` with exit code 0 immediately. That lets `runConversion` execute its
// full body (touchpaths → write temp file → push argv → await spawn → unlink)
// without launching Unity. We snapshot the argv the child was called with and
// verify the temp file's lifecycle via spying on `fs/promises`.

import { EventEmitter } from 'events'
import * as fs from 'fs/promises'
import * as path from 'path'
import * as os from 'os'

jest.mock('child_process', () => {
  const actual = jest.requireActual('child_process')
  return {
    ...actual,
    spawn: jest.fn()
  }
})

import { spawn } from 'child_process'
import { runConversion, runLodsConversion, startManifestBuilder } from '../../src/logic/run-conversion'

const mockedSpawn = spawn as unknown as jest.Mock

function makeChildStub(exitCode = 0) {
  // `execCommand` chains `.on('exit', ...).on('error', ...)` and reads
  // child.stdout/stderr for data events; the stub needs to satisfy all of
  // that shape. EventEmitter already supports chainable `.on`.
  const child: any = new EventEmitter()
  child.stdout = new EventEmitter()
  child.stderr = new EventEmitter()
  child.pid = 12345
  child.killed = false
  child.kill = jest.fn()
  // Emit `exit` (not `close`) on next tick — execCommand resolves on `exit`.
  setImmediate(() => child.emit('exit', exitCode, null))
  return child
}

function makeMockLogger(): any {
  return {
    info: jest.fn(),
    debug: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    log: jest.fn()
  }
}

function makeMockComponents(): any {
  return {
    metrics: {
      increment: jest.fn(),
      decrement: jest.fn(),
      observe: jest.fn(),
      startTimer: jest.fn(() => ({ end: jest.fn() }))
    }
  }
}

describe('when runConversion is invoked with per-asset deps digests', () => {
  let outDirectory: string
  let expectedDigestsFile: string

  beforeEach(async () => {
    outDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'run-conv-digests-'))
    expectedDigestsFile = `${outDirectory}.deps-digests.json`
    mockedSpawn.mockReset()
    // mockImplementation (not mockReturnValue) so the stub is built when spawn
    // is called by runConversion — otherwise the `setImmediate` inside the
    // stub fires at beforeEach time, before any `.on('exit')` listener exists.
    mockedSpawn.mockImplementation(() => makeChildStub(0))
  })

  afterEach(async () => {
    await fs.rm(outDirectory, { recursive: true, force: true })
    // Belt-and-suspenders — the finally block in runConversion should have
    // already cleaned this up.
    try {
      await fs.unlink(expectedDigestsFile)
    } catch {}
  })

  describe('and the digest map is non-empty', () => {
    let argvSnapshot: string[]

    beforeEach(async () => {
      await runConversion(makeMockLogger(), makeMockComponents(), {
        logFile: path.join(outDirectory, 'log.txt'),
        outDirectory,
        entityId: 'bafy-unit',
        entityType: 'scene',
        contentServerUrl: 'https://peer.decentraland.org/content',
        unityPath: '/fake/unity',
        projectPath: '/fake/project',
        timeout: 60_000,
        unityBuildTarget: 'StandaloneWindows64',
        animation: 'legacy',
        doISS: false,
        depsDigestByHash: new Map([
          ['hashA', 'digestA00000000000000000000000000'],
          ['hashB', 'digestB00000000000000000000000000']
        ])
      })

      argvSnapshot = mockedSpawn.mock.calls[0][1]
    })

    it('should push -depsDigestsFile pointing at the sibling-of-outDirectory path', () => {
      const idx = argvSnapshot.indexOf('-depsDigestsFile')
      expect(idx).toBeGreaterThan(-1)
      expect(argvSnapshot[idx + 1]).toBe(expectedDigestsFile)
    })

    it('should write the temp file OUTSIDE outDirectory so uploadDir cannot leak it', async () => {
      // The finally block unlinked it after Unity exited; we only assert the
      // path was chosen outside outDirectory so the leak class is impossible.
      expect(path.dirname(expectedDigestsFile)).toBe(path.dirname(outDirectory))
      expect(expectedDigestsFile.startsWith(outDirectory + path.sep)).toBe(false)
    })

    it('should unlink the temp file after Unity exits (no sidecar left behind)', async () => {
      await expect(fs.access(expectedDigestsFile)).rejects.toThrow()
    })
  })

  describe('and the digest map is empty', () => {
    let argvSnapshot: string[]

    beforeEach(async () => {
      await runConversion(makeMockLogger(), makeMockComponents(), {
        logFile: path.join(outDirectory, 'log.txt'),
        outDirectory,
        entityId: 'bafy-unit',
        entityType: 'scene',
        contentServerUrl: 'https://peer.decentraland.org/content',
        unityPath: '/fake/unity',
        projectPath: '/fake/project',
        timeout: 60_000,
        unityBuildTarget: 'StandaloneWindows64',
        animation: 'legacy',
        doISS: false,
        depsDigestByHash: new Map()
      })

      argvSnapshot = mockedSpawn.mock.calls[0][1]
    })

    it('should NOT push -depsDigestsFile (nothing to tell Unity)', () => {
      expect(argvSnapshot).not.toContain('-depsDigestsFile')
    })

    it('should NOT create the temp file', async () => {
      await expect(fs.access(expectedDigestsFile)).rejects.toThrow()
    })
  })

  describe('and the caller passes outDirectory with a trailing slash', () => {
    // Regression guard: naive concatenation `${outDir}.deps-digests.json`
    // with a trailing slash produces `/tmp/x/.deps-digests.json` — INSIDE
    // outDirectory — silently defeating the "adjacent path, cannot leak via
    // readdir/uploadDir" invariant. path.resolve normalizes.
    let argv: string[]

    beforeEach(async () => {
      await runConversion(makeMockLogger(), makeMockComponents(), {
        logFile: path.join(outDirectory, 'log.txt'),
        outDirectory: outDirectory + '/', // trailing slash
        entityId: 'bafy',
        entityType: 'scene',
        contentServerUrl: 'https://peer.decentraland.org/content',
        unityPath: '/fake/unity',
        projectPath: '/fake/project',
        timeout: 60_000,
        unityBuildTarget: 'StandaloneWindows64',
        animation: 'legacy',
        doISS: false,
        depsDigestByHash: new Map([['h', 'd' + '0'.repeat(31)]])
      })

      argv = mockedSpawn.mock.calls[0][1]
    })

    it('should still place the sidecar OUTSIDE outDirectory even with a trailing-slash input', () => {
      const idx = argv.indexOf('-depsDigestsFile')
      const sidecarPath = argv[idx + 1]
      // Normalize both sides for the comparison — path.sep guards against
      // Windows vs POSIX separator differences if this ever runs on CI win.
      const normalizedOutDir = path.resolve(outDirectory)
      expect(sidecarPath.startsWith(normalizedOutDir + path.sep)).toBe(false)
      expect(sidecarPath).toBe(`${normalizedOutDir}.deps-digests.json`)
    })
  })

  describe('and depsDigestByHash is undefined (asset reuse off)', () => {
    let argvSnapshot: string[]

    beforeEach(async () => {
      await runConversion(makeMockLogger(), makeMockComponents(), {
        logFile: path.join(outDirectory, 'log.txt'),
        outDirectory,
        entityId: 'bafy-unit',
        entityType: 'scene',
        contentServerUrl: 'https://peer.decentraland.org/content',
        unityPath: '/fake/unity',
        projectPath: '/fake/project',
        timeout: 60_000,
        unityBuildTarget: 'StandaloneWindows64',
        animation: 'legacy',
        doISS: false
      })

      argvSnapshot = mockedSpawn.mock.calls[0][1]
    })

    it('should NOT push -depsDigestsFile', () => {
      expect(argvSnapshot).not.toContain('-depsDigestsFile')
    })
  })

  describe('and Unity exits non-zero', () => {
    beforeEach(() => {
      mockedSpawn.mockImplementation(() => makeChildStub(42))
    })

    it('should still unlink the sidecar file (finally always runs)', async () => {
      await runConversion(makeMockLogger(), makeMockComponents(), {
        logFile: path.join(outDirectory, 'log.txt'),
        outDirectory,
        entityId: 'bafy-unit',
        entityType: 'scene',
        contentServerUrl: 'https://peer.decentraland.org/content',
        unityPath: '/fake/unity',
        projectPath: '/fake/project',
        timeout: 60_000,
        unityBuildTarget: 'StandaloneWindows64',
        animation: 'legacy',
        doISS: false,
        depsDigestByHash: new Map([['h', 'd' + '0'.repeat(31)]])
      })

      await expect(fs.access(expectedDigestsFile)).rejects.toThrow()
    })
  })
})

describe('when runConversion normalises the content server URL for the -baseUrl flag', () => {
  let outDirectory: string

  beforeEach(async () => {
    outDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'run-conv-baseurl-'))
    mockedSpawn.mockReset()
    mockedSpawn.mockImplementation(() => makeChildStub(0))
  })

  afterEach(async () => {
    await fs.rm(outDirectory, { recursive: true, force: true })
  })

  async function baseUrlArg(contentServerUrl: string): Promise<string> {
    await runConversion(makeMockLogger(), makeMockComponents(), {
      logFile: path.join(outDirectory, 'log.txt'),
      outDirectory,
      entityId: 'bafy',
      entityType: 'scene',
      contentServerUrl,
      unityPath: '/fake/unity',
      projectPath: '/fake/project',
      timeout: 60_000,
      unityBuildTarget: 'StandaloneWindows64',
      animation: 'legacy',
      doISS: false
    })
    const argv: string[] = mockedSpawn.mock.calls[0][1]
    return argv[argv.indexOf('-baseUrl') + 1]
  }

  describe('and the URL has no trailing slash', () => {
    it('should append /contents/', async () => {
      expect(await baseUrlArg('https://peer.decentraland.org/content')).toBe(
        'https://peer.decentraland.org/content/contents/'
      )
    })
  })

  describe('and the URL already ends in contents/', () => {
    it('should leave it untouched', async () => {
      expect(await baseUrlArg('https://peer.decentraland.org/content/contents/')).toBe(
        'https://peer.decentraland.org/content/contents/'
      )
    })
  })

  describe('and the URL is the sdk-team-cdn IPFS endpoint', () => {
    it('should be left as-is (special-cased) rather than having contents/ appended', async () => {
      expect(await baseUrlArg('https://sdk-team-cdn.decentraland.org/ipfs/')).toBe(
        'https://sdk-team-cdn.decentraland.org/ipfs/'
      )
    })
  })
})

describe('when runConversion pushes the legacy -cachedHashes flag', () => {
  let outDirectory: string

  beforeEach(async () => {
    outDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'run-conv-cached-'))
    mockedSpawn.mockReset()
    mockedSpawn.mockImplementation(() => makeChildStub(0))
  })

  afterEach(async () => {
    await fs.rm(outDirectory, { recursive: true, force: true })
  })

  describe('and cachedHashes is a non-empty array', () => {
    let argv: string[]

    beforeEach(async () => {
      await runConversion(makeMockLogger(), makeMockComponents(), {
        logFile: path.join(outDirectory, 'log.txt'),
        outDirectory,
        entityId: 'bafy',
        entityType: 'scene',
        contentServerUrl: 'https://peer.decentraland.org/content',
        unityPath: '/fake/unity',
        projectPath: '/fake/project',
        timeout: 60_000,
        unityBuildTarget: 'StandaloneWindows64',
        animation: 'legacy',
        doISS: false,
        cachedHashes: ['hashA', 'hashB', 'hashC']
      })
      argv = mockedSpawn.mock.calls[0][1]
    })

    it('should join them with semicolons and pass as a single string', () => {
      const idx = argv.indexOf('-cachedHashes')
      expect(idx).toBeGreaterThan(-1)
      expect(argv[idx + 1]).toBe('hashA;hashB;hashC')
    })
  })

  describe('and cachedHashes is an empty array', () => {
    let argv: string[]

    beforeEach(async () => {
      await runConversion(makeMockLogger(), makeMockComponents(), {
        logFile: path.join(outDirectory, 'log.txt'),
        outDirectory,
        entityId: 'bafy',
        entityType: 'scene',
        contentServerUrl: 'https://peer.decentraland.org/content',
        unityPath: '/fake/unity',
        projectPath: '/fake/project',
        timeout: 60_000,
        unityBuildTarget: 'StandaloneWindows64',
        animation: 'legacy',
        doISS: false,
        cachedHashes: []
      })
      argv = mockedSpawn.mock.calls[0][1]
    })

    it('should NOT push the flag (empty is the no-op shape)', () => {
      expect(argv).not.toContain('-cachedHashes')
    })
  })
})

describe('when runConversion forwards the -skippedHashes flag', () => {
  let outDirectory: string

  beforeEach(async () => {
    outDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'run-conv-skipped-'))
    mockedSpawn.mockReset()
    mockedSpawn.mockImplementation(() => makeChildStub(0))
  })

  afterEach(async () => {
    await fs.rm(outDirectory, { recursive: true, force: true })
  })

  describe('and skippedHashes is a non-empty array', () => {
    let argv: string[]

    beforeEach(async () => {
      await runConversion(makeMockLogger(), makeMockComponents(), {
        logFile: path.join(outDirectory, 'log.txt'),
        outDirectory,
        entityId: 'bafy',
        entityType: 'scene',
        contentServerUrl: 'https://peer.decentraland.org/content',
        unityPath: '/fake/unity',
        projectPath: '/fake/project',
        timeout: 60_000,
        unityBuildTarget: 'StandaloneWindows64',
        animation: 'legacy',
        doISS: false,
        skippedHashes: ['brokenA', 'brokenB']
      })
      argv = mockedSpawn.mock.calls[0][1]
    })

    it('should join them with semicolons and pass after the flag', () => {
      const idx = argv.indexOf('-skippedHashes')
      expect(idx).toBeGreaterThan(-1)
      expect(argv[idx + 1]).toBe('brokenA;brokenB')
    })
  })

  describe('and skippedHashes is undefined (back-compat with older callers)', () => {
    let argv: string[]

    beforeEach(async () => {
      await runConversion(makeMockLogger(), makeMockComponents(), {
        logFile: path.join(outDirectory, 'log.txt'),
        outDirectory,
        entityId: 'bafy',
        entityType: 'scene',
        contentServerUrl: 'https://peer.decentraland.org/content',
        unityPath: '/fake/unity',
        projectPath: '/fake/project',
        timeout: 60_000,
        unityBuildTarget: 'StandaloneWindows64',
        animation: 'legacy',
        doISS: false
      })
      argv = mockedSpawn.mock.calls[0][1]
    })

    it('should NOT push the flag (Unity behaves as before when omitted)', () => {
      expect(argv).not.toContain('-skippedHashes')
    })
  })

  describe('and skippedHashes is an empty array', () => {
    let argv: string[]

    beforeEach(async () => {
      await runConversion(makeMockLogger(), makeMockComponents(), {
        logFile: path.join(outDirectory, 'log.txt'),
        outDirectory,
        entityId: 'bafy',
        entityType: 'scene',
        contentServerUrl: 'https://peer.decentraland.org/content',
        unityPath: '/fake/unity',
        projectPath: '/fake/project',
        timeout: 60_000,
        unityBuildTarget: 'StandaloneWindows64',
        animation: 'legacy',
        doISS: false,
        skippedHashes: []
      })
      argv = mockedSpawn.mock.calls[0][1]
    })

    it('should NOT push the flag (empty is the no-op shape)', () => {
      expect(argv).not.toContain('-skippedHashes')
    })
  })
})

describe('when runConversion selects the animation method', () => {
  let outDirectory: string

  beforeEach(async () => {
    outDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'run-conv-anim-'))
    mockedSpawn.mockReset()
    mockedSpawn.mockImplementation(() => makeChildStub(0))
  })

  afterEach(async () => {
    await fs.rm(outDirectory, { recursive: true, force: true })
  })

  async function animArg(animation: string | undefined): Promise<string> {
    await runConversion(makeMockLogger(), makeMockComponents(), {
      logFile: path.join(outDirectory, 'log.txt'),
      outDirectory,
      entityId: 'bafy',
      entityType: 'scene',
      contentServerUrl: 'https://peer.decentraland.org/content',
      unityPath: '/fake/unity',
      projectPath: '/fake/project',
      timeout: 60_000,
      unityBuildTarget: 'StandaloneWindows64',
      animation,
      doISS: false
    })
    const argv: string[] = mockedSpawn.mock.calls[0][1]
    return argv[argv.indexOf('-animation') + 1]
  }

  describe('and animation is undefined', () => {
    it('should default to "legacy"', async () => {
      expect(await animArg(undefined)).toBe('legacy')
    })
  })

  describe('and animation is an explicit string', () => {
    it('should pass the value through unchanged', async () => {
      expect(await animArg('mecanim')).toBe('mecanim')
    })
  })
})

describe('when runLodsConversion constructs its Unity command line', () => {
  let outDirectory: string
  let argv: string[]

  beforeEach(async () => {
    outDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'run-lods-'))
    mockedSpawn.mockReset()
    mockedSpawn.mockImplementation(() => makeChildStub(0))

    await runLodsConversion(makeMockLogger(), makeMockComponents(), {
      logFile: path.join(outDirectory, 'log.txt'),
      outDirectory,
      entityId: 'bafy-lods',
      lods: ['lod1', 'lod2', 'lod3'],
      unityPath: '/fake/unity',
      projectPath: '/fake/project',
      timeout: 60_000,
      unityBuildTarget: 'WebGL'
    })
    argv = mockedSpawn.mock.calls[0][1]
  })

  afterEach(async () => {
    await fs.rm(outDirectory, { recursive: true, force: true })
  })

  it('should invoke the LOD-specific ExecuteMethod', () => {
    const idx = argv.indexOf('-executeMethod')
    expect(argv[idx + 1]).toBe('DCL.ABConverter.LODClient.ExportURLLODsToAssetBundles')
  })

  it('should pass the LOD list joined with semicolons', () => {
    const idx = argv.indexOf('-lods')
    expect(argv[idx + 1]).toBe('lod1;lod2;lod3')
  })

  it('should always request -deleteDownloadPathAfterFinished (LODs do not benefit from cache retention)', () => {
    expect(argv).toContain('-deleteDownloadPathAfterFinished')
  })

  it('should NOT push -depsDigestsFile or -cachedHashes (LODs do not participate in asset reuse)', () => {
    expect(argv).not.toContain('-depsDigestsFile')
    expect(argv).not.toContain('-cachedHashes')
  })
})

describe('when executeProgram kills a child that exceeds its timeout', () => {
  let outDirectory: string
  let hangingChild: any
  let metrics: any
  let logger: any

  beforeEach(async () => {
    outDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'run-conv-timeout-'))
    mockedSpawn.mockReset()

    hangingChild = new EventEmitter()
    hangingChild.stdout = new EventEmitter()
    hangingChild.stderr = new EventEmitter()
    hangingChild.pid = 99999
    hangingChild.killed = false
    // kill() on a real process would SIGKILL and the OS would emit 'exit'.
    // The stub just records the call — we don't want to ALSO emit 'exit' here
    // because executeProgram has already called `exitPromise.reject(...)` by
    // the time it invokes kill, and a subsequent resolve on a settled future
    // would be a no-op anyway but muddies the event ordering.
    hangingChild.kill = jest.fn(() => {
      hangingChild.killed = true
      return true
    })
    mockedSpawn.mockImplementation(() => hangingChild)

    logger = makeMockLogger()
    metrics = makeMockComponents().metrics
  })

  afterEach(async () => {
    await fs.rm(outDirectory, { recursive: true, force: true })
  })

  it('should SIGKILL the child and bump the ab_converter_timeout metric when the deadline elapses', async () => {
    // Real short timeout — fake timers interfere with fs async I/O used in
    // setupStartDirectories, causing the whole promise to hang.
    const runPromise = runConversion(
      logger,
      { metrics } as any,
      {
        logFile: path.join(outDirectory, 'log.txt'),
        outDirectory,
        entityId: 'bafy-timeout',
        entityType: 'scene',
        contentServerUrl: 'https://peer.decentraland.org/content',
        unityPath: '/fake/unity',
        projectPath: '/fake/project',
        timeout: 50,
        unityBuildTarget: 'StandaloneWindows64',
        animation: 'legacy',
        doISS: false
      }
    )

    await expect(runPromise).rejects.toThrow(/did not finish/)
    expect(hangingChild.kill).toHaveBeenCalledWith('SIGKILL')
    expect(metrics.increment).toHaveBeenCalledWith('ab_converter_timeout')
  })
})

describe('when startManifestBuilder spawns the scene-manifest npm script', () => {
  // Standalone helper for the ISS-scene-manifest flow. Worth covering directly
  // because the only way to reach it via runConversion is
  // `entityType === 'scene' && unityBuildTarget !== 'WebGL' && doISS` — which
  // `runConversion` catches-and-logs on failure, so a regression in the spawn
  // plumbing here would be invisible in integration tests.
  beforeEach(() => {
    mockedSpawn.mockReset()
  })

  describe('and the child exits with code 0', () => {
    it('should resolve', async () => {
      mockedSpawn.mockImplementation(() => {
        const child: any = new EventEmitter()
        setImmediate(() => child.emit('close', 0))
        return child
      })
      await expect(startManifestBuilder('scene-cid', '/tmp/manifest', 'https://peer.decentraland.org')).resolves.toBeUndefined()
    })
  })

  describe('and the child exits with a non-zero code', () => {
    it('should reject with the exit code in the error message', async () => {
      mockedSpawn.mockImplementation(() => {
        const child: any = new EventEmitter()
        setImmediate(() => child.emit('close', 7))
        return child
      })
      await expect(
        startManifestBuilder('scene-cid', '/tmp/manifest', 'https://peer.decentraland.org')
      ).rejects.toThrow(/code 7/)
    })
  })
})

describe('when runConversion is asked to run with doISS enabled on a desktop target', () => {
  let outDirectory: string
  let logger: any

  beforeEach(async () => {
    outDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'run-conv-iss-'))
    mockedSpawn.mockReset()
    logger = makeMockLogger()
  })

  afterEach(async () => {
    await fs.rm(outDirectory, { recursive: true, force: true })
  })

  describe('and the scene manifest builder exits non-zero', () => {
    let firstInvocationSpawned: any
    let secondInvocationSpawned: any

    beforeEach(async () => {
      // spawn is called twice: once for the manifest builder (fails), once
      // for the Unity child (succeeds). runConversion catches the manifest
      // builder error and proceeds with the Unity spawn regardless.
      mockedSpawn.mockImplementation(() => {
        const child: any = new EventEmitter()
        child.stdout = new EventEmitter()
        child.stderr = new EventEmitter()
        child.pid = 1
        child.killed = false
        child.kill = jest.fn()
        if (mockedSpawn.mock.calls.length === 1) {
          // first call = manifest builder, emit `close` with non-zero
          firstInvocationSpawned = child
          setImmediate(() => child.emit('close', 1))
        } else {
          // second call = Unity, emit `exit` with 0
          secondInvocationSpawned = child
          setImmediate(() => child.emit('exit', 0, null))
        }
        return child
      })

      await runConversion(logger, makeMockComponents(), {
        logFile: path.join(outDirectory, 'log.txt'),
        outDirectory,
        entityId: 'bafy-iss',
        entityType: 'scene',
        contentServerUrl: 'https://peer.decentraland.org/content',
        unityPath: '/fake/unity',
        projectPath: '/fake/project',
        timeout: 60_000,
        unityBuildTarget: 'StandaloneWindows64',
        animation: 'legacy',
        doISS: true
      })
    })

    it('should log the manifest-builder failure via logger.error', () => {
      expect(logger.error).toHaveBeenCalledWith(
        expect.stringContaining('Failed to generate scene manifest')
      )
    })

    it('should still invoke Unity afterwards', () => {
      expect(firstInvocationSpawned).toBeDefined()
      expect(secondInvocationSpawned).toBeDefined()
    })
  })

  describe('and the build target is WebGL', () => {
    it('should skip the manifest builder entirely regardless of doISS', async () => {
      mockedSpawn.mockImplementation(() => makeChildStub(0))
      await runConversion(logger, makeMockComponents(), {
        logFile: path.join(outDirectory, 'log.txt'),
        outDirectory,
        entityId: 'bafy-iss-webgl',
        entityType: 'scene',
        contentServerUrl: 'https://peer.decentraland.org/content',
        unityPath: '/fake/unity',
        projectPath: '/fake/project',
        timeout: 60_000,
        unityBuildTarget: 'WebGL',
        animation: 'legacy',
        doISS: true
      })
      // Only the Unity spawn should have happened. No manifest builder call.
      expect(mockedSpawn).toHaveBeenCalledTimes(1)
      const argv = mockedSpawn.mock.calls[0][1]
      // The Unity invocation uses `-projectPath`; the manifest builder uses
      // `run start`. Assert we got the Unity one.
      expect(argv).toContain('-projectPath')
    })
  })

  describe('and the entity is not a scene', () => {
    it('should skip the manifest builder even when doISS is set', async () => {
      mockedSpawn.mockImplementation(() => makeChildStub(0))
      await runConversion(logger, makeMockComponents(), {
        logFile: path.join(outDirectory, 'log.txt'),
        outDirectory,
        entityId: 'bafy-iss-wearable',
        entityType: 'wearable',
        contentServerUrl: 'https://peer.decentraland.org/content',
        unityPath: '/fake/unity',
        projectPath: '/fake/project',
        timeout: 60_000,
        unityBuildTarget: 'StandaloneWindows64',
        animation: 'legacy',
        doISS: true
      })
      expect(mockedSpawn).toHaveBeenCalledTimes(1)
    })
  })
})
