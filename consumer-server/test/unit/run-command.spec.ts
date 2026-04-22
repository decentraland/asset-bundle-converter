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
    it('should resolve the exit promise with the child exit code', async () => {
      const { exitPromise } = execCommand(logger, '/bin/sh', ['-c', 'exit 0'], process.env as any, process.cwd())
      await expect(exitPromise).resolves.toBe(0)
    })

    it('should resolve with a non-zero exit code when the child returns non-zero', async () => {
      const { exitPromise } = execCommand(logger, '/bin/sh', ['-c', 'exit 7'], process.env as any, process.cwd())
      await expect(exitPromise).resolves.toBe(7)
    })
  })

  describe('when killProcessTree is called on a child that spawned grandchildren', () => {
    let grandchildPid: number
    let exitOutcome: 'resolved' | 'rejected' | 'pending'
    let killResult: boolean

    beforeEach(async () => {
      // Parent shell prints the PID of a long-sleeping grandchild, then
      // sleeps itself. We capture the grandchild PID and then tree-kill.
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

      // Collect grandchild PID from the child's stdout via the logger mock.
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

    it('should return true from killProcessTree indicating the signal was delivered', () => {
      expect(killResult).toBe(true)
    })

    it('should kill the grandchild process too, not just the direct child', async () => {
      await expect(isProcessAlive(grandchildPid)).resolves.toBe(false)
    })

    it('should cause the exit promise to reject with "SIGTERM sent to the process"', () => {
      expect(exitOutcome).toBe('rejected')
    })
  })

  describe('when killProcessTree is called after the child has already exited', () => {
    it('should return true and not log any warning (ESRCH is expected)', async () => {
      const { exitPromise, killProcessTree } = execCommand(
        logger,
        '/bin/sh',
        ['-c', 'exit 0'],
        process.env as any,
        process.cwd()
      )
      await exitPromise
      await sleep(50)

      const result = killProcessTree('SIGKILL')

      expect(result).toBe(true)
      expect(logger.warn).not.toHaveBeenCalled()
    })
  })
})
