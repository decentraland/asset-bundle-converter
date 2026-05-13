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
  return {
    getFreeBytes: jest.fn(async () => 100 * 1e9),
    isBelowMinimum: jest.fn(async () => false)
  } as unknown as MockedFilesystemComponent
}
