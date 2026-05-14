import type { IFilesystemComponent } from '../../src/adapters/filesystem'

export type MockedFilesystemComponent = jest.Mocked<IFilesystemComponent>

/**
 * Build a filesystem mock with defaults that mirror "healthy" disk state:
 * 100 GB free, never below minimum. Override per test when the loops should
 * see a low-disk signal:
 *
 * ```ts
 * const filesystem = createFilesystemMock()
 * filesystem.isBelowMinimum.mockResolvedValueOnce(true)
 * ```
 *
 * The "healthy" defaults are deliberate — most tests don't care about
 * disk-pressure shutdown and would otherwise have to set this up at every
 * call site.
 */
export function createFilesystemMock(): MockedFilesystemComponent {
  // Build with bare `jest.fn()`s — these are `Mock<unknown, unknown>` and
  // assignable to any function shape, so the interface contract is satisfied
  // without an `unknown` cast. Apply the "healthy disk" defaults via
  // `mockResolvedValue` so tests that don't override get 100 GB free / not
  // below minimum, but the methods retain their proper `jest.MockedFunction`
  // typing from the interface.
  const mock: MockedFilesystemComponent = {
    getFreeBytes: jest.fn(),
    isBelowMinimum: jest.fn()
  }
  mock.getFreeBytes.mockResolvedValue(100 * 1e9)
  mock.isBelowMinimum.mockResolvedValue(false)
  return mock
}
