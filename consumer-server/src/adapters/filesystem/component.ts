import checkDiskSpace from 'check-disk-space'
import type { AppComponents } from '../../types'
import type { FilesystemComponentOptions, IFilesystemComponent } from './types'

const DEFAULT_PATH = '/'
const DEFAULT_MINIMUM_FREE_BYTES = 1e9 // 1 GB

export async function createFilesystemComponent(
  components: Pick<AppComponents, 'metrics'>,
  options: FilesystemComponentOptions = {}
): Promise<IFilesystemComponent> {
  const path = options.path ?? DEFAULT_PATH
  const minimumFreeBytes = options.minimumFreeBytes ?? DEFAULT_MINIMUM_FREE_BYTES

  async function getFreeBytes(): Promise<number> {
    const usage = await checkDiskSpace(path)
    components.metrics.observe('ab_converter_free_disk_space', {}, usage.free)
    return usage.free
  }

  async function isBelowMinimum(): Promise<boolean> {
    return (await getFreeBytes()) < minimumFreeBytes
  }

  return { getFreeBytes, isBelowMinimum }
}
