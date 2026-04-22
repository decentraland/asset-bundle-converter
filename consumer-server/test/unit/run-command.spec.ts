import * as fs from 'fs/promises'
import * as path from 'path'
import * as os from 'os'

import { execCommand } from '../../src/logic/run-command'
import { ILoggerComponent } from '@well-known-components/interfaces'

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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function isProcessAlive(pid: number): Promise<boolean> {
  try {
    // Signal 0 is a probe: does not send a signal, just checks reachability.
    process.kill(pid, 0)
    return true
  } catch (err: any) {
    return err?.code === 'EPERM'
  }
}

async function waitForFile(filePath: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      await fs.access(filePath)
      return
    } catch {
      await sleep(25)
    }
  }
  throw new Error(`Timed out waiting for ${filePath}`)
}

describe('execCommand', () => {
  let logger: LoggerMock

  beforeEach(() => {
    logger = createLoggerMock()
  })

  afterEach(() => {
    jest.clearAllMocks()
  })

  describe('when the command exits cleanly', () => {
    describe('and the command returns exit code 0', () => {
      let resolvedCode: number | null

      beforeEach(async () => {
        const { exitPromise } = execCommand(logger, '/bin/sh', ['-c', 'exit 0'], process.env as any, process.cwd())
        resolvedCode = await exitPromise
      })

      it('should resolve the exit promise with 0', () => {
        expect(resolvedCode).toBe(0)
      })
    })

    describe('and the command returns a non-zero exit code', () => {
      let resolvedCode: number | null

      beforeEach(async () => {
        const { exitPromise } = execCommand(logger, '/bin/sh', ['-c', 'exit 7'], process.env as any, process.cwd())
        resolvedCode = await exitPromise
      })

      it('should resolve the exit promise with that non-zero code', () => {
        expect(resolvedCode).toBe(7)
      })
    })
  })

  describe('when spawn itself fails because the executable does not exist', () => {
    let rejection: any

    beforeEach(async () => {
      const { exitPromise } = execCommand(
        logger,
        '/definitely/not/a/real/binary-xyz',
        [],
        process.env as any,
        process.cwd()
      )
      rejection = await exitPromise.then(
        () => {
          throw new Error('expected rejection, got resolution')
        },
        (err) => err
      )
    })

    it('should reject the exit promise with an ENOENT spawn error', () => {
      expect(rejection).toMatchObject({
        code: 'ENOENT',
        message: expect.stringContaining('ENOENT')
      })
    })

    it('should log the spawn error via the logger', () => {
      expect(logger.error).toHaveBeenCalled()
    })
  })

  describe('when killProcessTree is called on a child that spawned a grandchild', () => {
    let handshakeDir: string
    let grandchildPid: number
    let exitOutcome: 'resolved' | 'rejected' | 'pending'
    let killResult: boolean

    beforeEach(async () => {
      // Deterministic handshake via a tmpfile: the child shell writes its
      // grandchild PID to a known path, and the test waits for that file.
      // More robust than polling the child's stdout through the logger mock.
      handshakeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'run-cmd-test-'))
      const pidFile = path.join(handshakeDir, 'grandchild.pid')
      const script = `
        sleep 300 &
        echo "$!" > "${pidFile}"
        sleep 300
      `

      const { exitPromise, child, killProcessTree } = execCommand(
        logger,
        '/bin/sh',
        ['-c', script],
        process.env as any,
        process.cwd()
      )

      exitOutcome = 'pending'
      void exitPromise.then(
        () => (exitOutcome = 'resolved'),
        () => (exitOutcome = 'rejected')
      )

      await waitForFile(pidFile, 5000)
      grandchildPid = parseInt((await fs.readFile(pidFile, 'utf8')).trim(), 10)

      expect(child.pid).toBeDefined()
      expect(grandchildPid).toBeGreaterThan(0)
      await expect(isProcessAlive(grandchildPid)).resolves.toBe(true)

      killResult = killProcessTree('SIGKILL')

      // Give the kernel a moment to deliver signals and reap.
      await sleep(200)
      await exitPromise.catch(() => undefined)
    }, 10_000)

    afterEach(async () => {
      await fs.rm(handshakeDir, { recursive: true, force: true })
    })

    it('should return true indicating the signal was delivered to the group', () => {
      expect(killResult).toBe(true)
    })

    it('should kill the grandchild process, not just the direct child', async () => {
      await expect(isProcessAlive(grandchildPid)).resolves.toBe(false)
    })

    it("should reject the exit promise with 'SIGTERM sent to the process'", () => {
      expect(exitOutcome).toBe('rejected')
    })
  })

  describe('when killProcessTree is called after the child has already drained', () => {
    let killResult: boolean

    beforeEach(async () => {
      const { exitPromise, killProcessTree } = execCommand(
        logger,
        '/bin/sh',
        ['-c', 'exit 0'],
        process.env as any,
        process.cwd()
      )
      await exitPromise
      await sleep(50)
      killResult = killProcessTree('SIGKILL')
    })

    it('should return true because ESRCH is treated as success', () => {
      expect(killResult).toBe(true)
    })

    it('should not log a warning since ESRCH is expected after the group has drained', () => {
      expect(logger.warn).not.toHaveBeenCalled()
    })
  })
})
