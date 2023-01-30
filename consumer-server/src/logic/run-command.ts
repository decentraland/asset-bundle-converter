import { future } from 'fp-future'
import { spawn } from 'child_process'
import { ILoggerComponent } from '@well-known-components/interfaces'

export function execCommand(logger: ILoggerComponent.ILogger, command: string, args: string[], label: string, env: Record<string, string>, cwd: string) {
  const exitFuture = future<number | null>()

  const child = spawn(command, args, { env, cwd })
    .on('exit', (code) => exitFuture.resolve(code))
    .on('error', (error) => exitFuture.reject(error))

  child.stdout?.on('data', (data) => {
    logger.log(data)
  })

  child.stderr?.on('data', (data) =>
    logger.error(data)
  )

  return { exitPromise: exitFuture, child }
}
