import { future } from 'fp-future'
import { spawn } from 'child_process'
import { AppComponents } from '../types'

export function execCommand(components: Pick<AppComponents, 'logs'>, command: string, args: string[], label: string, env: Record<string, string>, cwd: string) {
  const exitFuture = future<number | null>()

  const logger = components.logs.getLogger(label)

  const child = spawn(command, args, { env, cwd })
    .on('exit', (code) => exitFuture.resolve(code))
    .on('error', (error) => exitFuture.reject(error))

  child.stdout?.on('data', (data) => {
    data
      .toString()
      .split(/\n/g)
      .map(logger.log)
  })

  child.stderr?.on('data', (data) =>
    data
      .toString()
      .split(/\n/g)
      .map(logger.error)
  )

  return { exitPromise: exitFuture, child }
}
