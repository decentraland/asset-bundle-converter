import { future } from 'fp-future'
import { spawn } from 'child_process'
import { ILoggerComponent } from '@well-known-components/interfaces'

export function execCommand(
  logger: ILoggerComponent.ILogger,
  command: string,
  args: string[],
  env: Record<string, string>,
  cwd: string
) {
  const exitFuture = future<number | null>()

  logger.debug('Running command', { command, args } as any)

  // `detached: true` makes the child a new process group leader (POSIX).
  // Without this, a subsequent SIGKILL only reaches the direct child —
  // Mono workers Unity spawned keep running, get reparented to PID 1, and
  // hold onto file descriptors and file locks across subsequent jobs.
  // Being a group leader lets us signal the whole tree via process.kill(-pid).
  //
  // We deliberately do NOT call child.unref() — Node should still wait on
  // the child's exit and keep piping stdio back to us.
  const child = spawn(command, args, { env, cwd, detached: true })

  function killProcessTree(signal: NodeJS.Signals = 'SIGKILL'): boolean {
    // Guards against undefined (spawn failed), pid=0 (would signal the
    // caller's own group on POSIX), and any hypothetical non-positive pid.
    if (!child.pid || child.pid <= 0) return false
    try {
      process.kill(-child.pid, signal)
      return true
    } catch (err: any) {
      // ESRCH means the group has already drained (every process in it has
      // exited on its own). That's the normal case after a clean Unity run
      // and is not worth logging.
      if (err?.code !== 'ESRCH') {
        logger.warn(`Failed to ${signal} process tree for ${command} (pgid=${child.pid}): ${err?.message ?? err}`)
        return false
      }
      return true
    }
  }

  child
    .on('exit', (code, signal) => {
      // Post-exit sweep: kill anything still in Unity's process group. On a
      // clean exit this is a no-op (ESRCH); on a signal kill or crash it
      // reaps Mono workers that outlived Unity before they can persist as
      // orphans across jobs.
      killProcessTree('SIGKILL')
      logger.info('Command exited', { code, signal } as any)
      if (signal === 'SIGTERM' || signal === 'SIGKILL') {
        exitFuture.reject(new Error('SIGTERM sent to the process'))
      } else {
        exitFuture.resolve(code ?? -1)
      }
    })
    .on('error', (error) => {
      logger.error(error)
      exitFuture.reject(error)
    })

  child.stdout?.on('data', (data) => {
    logger.log(data)
  })

  child.stderr?.on('data', (data) => logger.error(data))

  return { exitPromise: exitFuture, child, killProcessTree }
}
