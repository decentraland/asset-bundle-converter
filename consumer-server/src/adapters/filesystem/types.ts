import type { IBaseComponent } from '@well-known-components/interfaces'

export type IFilesystemComponent = IBaseComponent & {
  /**
   * Returns the number of free bytes on the configured filesystem path.
   * Observes the `ab_converter_free_disk_space` gauge as a side effect so
   * Prometheus dashboards reflect each probe.
   */
  getFreeBytes(): Promise<number>

  /**
   * True when free space is below the configured minimum (default 1 GB).
   * The consumer loops use this as a graceful-stop signal: if the host is
   * about to fill up, stop accepting jobs rather than risk a Unity build
   * filling the disk and crashing the pod.
   */
  isBelowMinimum(): Promise<boolean>
}

export type FilesystemComponentOptions = {
  /** Filesystem path to probe. Defaults to `/`. */
  path?: string
  /**
   * Threshold in bytes. When free space dips below this, `isBelowMinimum`
   * returns true. Defaults to 1 GB.
   */
  minimumFreeBytes?: number
}
