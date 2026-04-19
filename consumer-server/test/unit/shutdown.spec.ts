import {
  _resetShutdownStateForTests,
  isShutdownRequested,
  requestShutdown,
  scheduleFatalExit
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
  })

  describe('when requestShutdown is called', () => {
    beforeEach(() => {
      requestShutdown()
    })

    it('should flip isShutdownRequested to true', () => {
      expect(isShutdownRequested()).toBe(true)
    })

    it('should not by itself schedule process.exit', () => {
      jest.advanceTimersByTime(120_000)
      expect(exitSpy).not.toHaveBeenCalled()
    })
  })

  describe('when scheduleFatalExit is called', () => {
    beforeEach(() => {
      scheduleFatalExit()
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

  describe('when scheduleFatalExit is called multiple times', () => {
    beforeEach(() => {
      scheduleFatalExit()
      scheduleFatalExit()
      scheduleFatalExit()
    })

    it('should only arm a single process.exit timer regardless of call count', () => {
      jest.advanceTimersByTime(60_000)
      expect(exitSpy).toHaveBeenCalledTimes(1)
    })
  })

  describe('when the fatal exit is scheduled but the timer has not yet fired', () => {
    beforeEach(() => {
      scheduleFatalExit()
    })

    it('should leave process.exitCode at 199 so a clean natural exit still signals failure to ECS', () => {
      // This is the belt-and-suspenders: even if something unref'd the timer
      // or Node managed to exit before 60s, exitCode=199 ensures ECS logs a
      // failed task rather than a success.
      jest.advanceTimersByTime(1_000)
      expect(process.exitCode).toBe(199)
    })
  })

  describe('when requestShutdown and scheduleFatalExit are both called', () => {
    beforeEach(() => {
      requestShutdown()
      scheduleFatalExit()
    })

    it('should both flip the shutdown flag and arm the fatal-exit timer', () => {
      expect(isShutdownRequested()).toBe(true)
      jest.advanceTimersByTime(60_000)
      expect(exitSpy).toHaveBeenCalledWith(199)
    })
  })
})
