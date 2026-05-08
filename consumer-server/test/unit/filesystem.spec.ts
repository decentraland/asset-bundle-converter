// Unit coverage for the filesystem adapter. Verifies the wiring around
// `check-disk-space`: that the configured path and threshold are honored,
// that the gauge is observed on every probe, and that the boolean
// `isBelowMinimum` boundary is the strict-less-than form (not <=).

jest.mock('check-disk-space', () => ({
  __esModule: true,
  default: jest.fn()
}))

import checkDiskSpace from 'check-disk-space'
import { createFilesystemComponent, IFilesystemComponent } from '../../src/adapters/filesystem'

const mockedCheckDiskSpace = checkDiskSpace as unknown as jest.Mock

type MetricsMock = {
  increment: jest.Mock
  decrement: jest.Mock
  observe: jest.Mock
  startTimer: jest.Mock
}

function makeMetricsMock(): MetricsMock {
  return {
    increment: jest.fn(),
    decrement: jest.fn(),
    observe: jest.fn(),
    startTimer: jest.fn(() => ({ end: jest.fn() }))
  }
}

describe('when getFreeBytes is called', () => {
  let metrics: MetricsMock
  let filesystem: IFilesystemComponent

  beforeEach(async () => {
    metrics = makeMetricsMock()
    mockedCheckDiskSpace.mockResolvedValueOnce({ free: 50 * 1e9, size: 100 * 1e9, diskPath: '/' })
    filesystem = await createFilesystemComponent({ metrics } as any)
  })

  afterEach(() => {
    jest.clearAllMocks()
  })

  describe('and the default path is used', () => {
    let result: number

    beforeEach(async () => {
      result = await filesystem.getFreeBytes()
    })

    it('should pass the default "/" path to check-disk-space', () => {
      expect(mockedCheckDiskSpace).toHaveBeenCalledWith('/')
    })

    it('should observe the ab_converter_free_disk_space gauge with the reported free byte count', () => {
      expect(metrics.observe).toHaveBeenCalledWith('ab_converter_free_disk_space', {}, 50 * 1e9)
    })

    it('should return the reported free byte count', () => {
      expect(result).toBe(50 * 1e9)
    })
  })
})

describe('when getFreeBytes is called and a custom path is configured via options', () => {
  let metrics: MetricsMock
  let filesystem: IFilesystemComponent

  beforeEach(async () => {
    metrics = makeMetricsMock()
    mockedCheckDiskSpace.mockResolvedValueOnce({ free: 7 * 1e9, size: 100 * 1e9, diskPath: '/var/data' })
    filesystem = await createFilesystemComponent({ metrics } as any, { path: '/var/data' })
    await filesystem.getFreeBytes()
  })

  afterEach(() => {
    jest.clearAllMocks()
  })

  it('should pass the configured path to check-disk-space', () => {
    expect(mockedCheckDiskSpace).toHaveBeenCalledWith('/var/data')
  })
})

describe('when isBelowMinimum is called', () => {
  let metrics: MetricsMock

  beforeEach(() => {
    metrics = makeMetricsMock()
  })

  afterEach(() => {
    jest.clearAllMocks()
  })

  describe('and free space is well above the default 1 GB threshold', () => {
    let result: boolean

    beforeEach(async () => {
      mockedCheckDiskSpace.mockResolvedValueOnce({ free: 5 * 1e9, size: 100 * 1e9, diskPath: '/' })
      const filesystem = await createFilesystemComponent({ metrics } as any)
      result = await filesystem.isBelowMinimum()
    })

    it('should return false', () => {
      expect(result).toBe(false)
    })
  })

  describe('and free space is below the default 1 GB threshold', () => {
    let result: boolean

    beforeEach(async () => {
      mockedCheckDiskSpace.mockResolvedValueOnce({ free: 100 * 1e6, size: 100 * 1e9, diskPath: '/' })
      const filesystem = await createFilesystemComponent({ metrics } as any)
      result = await filesystem.isBelowMinimum()
    })

    it('should return true', () => {
      expect(result).toBe(true)
    })
  })

  describe('and a custom minimumFreeBytes is configured', () => {
    describe('and free space is above the custom threshold', () => {
      let result: boolean

      beforeEach(async () => {
        mockedCheckDiskSpace.mockResolvedValueOnce({ free: 11 * 1e9, size: 100 * 1e9, diskPath: '/' })
        const filesystem = await createFilesystemComponent({ metrics } as any, { minimumFreeBytes: 10 * 1e9 })
        result = await filesystem.isBelowMinimum()
      })

      it('should return false', () => {
        expect(result).toBe(false)
      })
    })

    describe('and free space exactly equals the custom threshold', () => {
      let result: boolean

      beforeEach(async () => {
        mockedCheckDiskSpace.mockResolvedValueOnce({ free: 10 * 1e9, size: 100 * 1e9, diskPath: '/' })
        const filesystem = await createFilesystemComponent({ metrics } as any, { minimumFreeBytes: 10 * 1e9 })
        result = await filesystem.isBelowMinimum()
      })

      it('should return false because the comparison is strict less-than', () => {
        // Boundary spec: a host whose free space is *exactly* at the
        // configured floor should NOT trigger the graceful-stop. Catches
        // a refactor that flipped < to <=.
        expect(result).toBe(false)
      })
    })

    describe('and free space is below the custom threshold', () => {
      let result: boolean

      beforeEach(async () => {
        mockedCheckDiskSpace.mockResolvedValueOnce({ free: 9 * 1e9, size: 100 * 1e9, diskPath: '/' })
        const filesystem = await createFilesystemComponent({ metrics } as any, { minimumFreeBytes: 10 * 1e9 })
        result = await filesystem.isBelowMinimum()
      })

      it('should return true', () => {
        expect(result).toBe(true)
      })
    })
  })

  describe('and isBelowMinimum is called repeatedly', () => {
    beforeEach(async () => {
      mockedCheckDiskSpace.mockResolvedValueOnce({ free: 5 * 1e9, size: 100 * 1e9, diskPath: '/' })
      mockedCheckDiskSpace.mockResolvedValueOnce({ free: 5 * 1e9, size: 100 * 1e9, diskPath: '/' })
      const filesystem = await createFilesystemComponent({ metrics } as any)
      await filesystem.isBelowMinimum()
      await filesystem.isBelowMinimum()
    })

    it('should observe the gauge once per call (not cached)', () => {
      // Each disk probe must observe the gauge so dashboards reflect
      // current state, not the last-seen value at startup.
      expect(metrics.observe).toHaveBeenCalledTimes(2)
    })
  })
})
