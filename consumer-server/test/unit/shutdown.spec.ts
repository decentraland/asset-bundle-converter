import {
  _resetShutdownStateForTests,
  initiateGracefulCrashShutdown,
  isShutdownRequested
} from '../../src/logic/shutdown'

describe('shutdown state', () => {
  let exitSpy: jest.SpyInstance

  beforeEach(() => {
    jest.useFakeTimers()
    // process.exit must be mocked — a real call would kill the jest worker.
    exitSpy = jest.spyOn(process, 'exit').mockImplementation((() => undefined) as any)
    _resetShutdownStateForTests()
  })

  afterEach(() => {
    jest.useRealTimers()
    exitSpy.mockRestore()
    _resetShutdownStateForTests()
  })

  describe('when no failure has occurred', () => {
    it('should report that shutdown is not requested', () => {
      expect(isShutdownRequested()).toBe(false)
    })

    it('should not call process.exit', () => {
      jest.advanceTimersByTime(120_000)
      expect(exitSpy).not.toHaveBeenCalled()
    })
  })

  describe('when initiateGracefulCrashShutdown is called', () => {
    beforeEach(() => {
      initiateGracefulCrashShutdown()
    })

    it('should flip isShutdownRequested to true', () => {
      expect(isShutdownRequested()).toBe(true)
    })

    it('should set process.exitCode to 199 synchronously', () => {
      expect(process.exitCode).toBe(199)
    })

    it('should not call process.exit before the 60s timer fires', () => {
      jest.advanceTimersByTime(59_999)
      expect(exitSpy).not.toHaveBeenCalled()
    })

    it('should call process.exit with code 199 after the 60s timer fires', () => {
      jest.advanceTimersByTime(60_000)
      expect(exitSpy).toHaveBeenCalledWith(199)
    })
  })

  describe('when initiateGracefulCrashShutdown is called multiple times', () => {
    beforeEach(() => {
      initiateGracefulCrashShutdown()
      initiateGracefulCrashShutdown()
      initiateGracefulCrashShutdown()
    })

    it('should only arm a single process.exit timer regardless of call count', () => {
      jest.advanceTimersByTime(60_000)
      expect(exitSpy).toHaveBeenCalledTimes(1)
    })

    it('should keep the shutdown flag set', () => {
      expect(isShutdownRequested()).toBe(true)
    })
  })

  describe('when the fatal exit is armed but the timer has not yet fired', () => {
    beforeEach(() => {
      initiateGracefulCrashShutdown()
    })

    it('should leave process.exitCode at 199 so a clean natural exit still signals failure to ECS', () => {
      // Belt-and-suspenders: even if something unref'd the timer or Node
      // managed to exit before 60s, exitCode=199 ensures ECS logs a failed
      // task rather than a success.
      jest.advanceTimersByTime(1_000)
      expect(process.exitCode).toBe(199)
    })
  })
})
