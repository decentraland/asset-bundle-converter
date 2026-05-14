import checkDiskSpace from 'check-disk-space'
import type { AppComponents } from '../../types'
import type { FilesystemComponentOptions, IFilesystemComponent } from './types'

const DEFAULT_PATH = '/'
/** 1 GB. Below this the consumer loops gracefully stop accepting new jobs. */
const DEFAULT_MINIMUM_FREE_BYTES = 1e9

/**
 * Builds the `IFilesystemComponent`. Wraps the `check-disk-space` library
 * so tests can inject a fake and so the consumer loops have a single
 * place to observe the `ab_converter_free_disk_space` gauge.
 *
 * @param components - Needs only `metrics` for the gauge observation.
 * @param options - Optional overrides for the probed path (default `/`)
 *   and the `isBelowMinimum` threshold (default 1 GB).
 */
export async function createFilesystemComponent(
  components: Pick<AppComponents, 'metrics'>,
  options: FilesystemComponentOptions = {}
): Promise<IFilesystemComponent> {
  const path = options.path ?? DEFAULT_PATH
  const minimumFreeBytes = options.minimumFreeBytes ?? DEFAULT_MINIMUM_FREE_BYTES

  /**
   * Probes the filesystem and returns the free byte count. Observes
   * `ab_converter_free_disk_space` on every call so the gauge tracks
   * current state rather than the last-seen value at startup.
   */
  async function getFreeBytes(): Promise<number> {
    const usage = await checkDiskSpace(path)
    components.metrics.observe('ab_converter_free_disk_space', {}, usage.free)
    return usage.free
  }

  /**
   * @returns True when free space is strictly below the configured
   *   minimum. The strict less-than is deliberate — a host whose free
   *   space is exactly at the floor should not yet trigger the
   *   graceful-stop.
   */
  async function isBelowMinimum(): Promise<boolean> {
    return (await getFreeBytes()) < minimumFreeBytes
  }

  return { getFreeBytes, isBelowMinimum }
}
