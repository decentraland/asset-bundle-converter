import { future } from 'fp-future'
import { spawn } from 'child_process'
import { ILoggerComponent } from '@well-known-components/interfaces'

export function execCommand(logger: ILoggerComponent.ILogger, command: string, args: string[], env: Record<string, string>, cwd: string) {
  const exitFuture = future<number | null>()

  logger.debug('Running command', { command, args } as any)

  const child = spawn(command, args, { env, cwd })
    .on('exit', (code, signal) => {
      logger.info('Command exited', { code, signal } as any)
      if (signal === 'SIGTERM' || signal == 'SIGKILL') {
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

  child.stderr?.on('data', (data) =>
    logger.error(data)
  )

  return { exitPromise: exitFuture, child }
}
