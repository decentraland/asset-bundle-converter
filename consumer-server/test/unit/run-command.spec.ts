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

  describe('when killProcessTree is called on a child that spawned a grandchild', () => {
    let grandchildPid: number
    let exitOutcome: 'resolved' | 'rejected' | 'pending'
    let killResult: boolean

    beforeEach(async () => {
      // Parent shell prints the PID of a long-sleeping grandchild, then sleeps
      // itself. We capture the grandchild PID and then tree-kill.
      const script = `
        sleep 300 &
        echo "GRANDCHILD_PID=$!"
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

      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('grandchild PID not emitted in time')), 5000)
        const checkLogger = () => {
          const logCalls = logger.log.mock.calls
          for (const [payload] of logCalls) {
            const text = Buffer.isBuffer(payload) ? payload.toString() : String(payload)
            const match = text.match(/GRANDCHILD_PID=(\d+)/)
            if (match) {
              grandchildPid = parseInt(match[1], 10)
              clearTimeout(timer)
              resolve()
              return
            }
          }
          setTimeout(checkLogger, 50)
        }
        checkLogger()
      })

      expect(child.pid).toBeDefined()
      expect(grandchildPid).toBeGreaterThan(0)
      await expect(isProcessAlive(grandchildPid)).resolves.toBe(true)

      killResult = killProcessTree('SIGKILL')

      // Give the kernel a moment to deliver signals and reap.
      await sleep(200)
      await exitPromise.catch(() => undefined)
    }, 10_000)

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
