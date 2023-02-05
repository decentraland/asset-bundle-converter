import { ILoggerComponent } from '@well-known-components/interfaces'
import { closeSync, openSync, readFileSync } from 'fs'
import * as fs from 'fs/promises'
import { dirname } from 'path'
import { AppComponents } from '../types'
import { execCommand } from './run-command'
import future from 'fp-future'

export async function runConversion(
  logger: ILoggerComponent.ILogger,
  components: Pick<AppComponents, 'metrics'>,
  options: {
    logFile: string,
    outDirectory: string,
    entityId: string,
    contentServerUrl: string,
    unityPath: string,
    projectPath: string,
    timeout: number
  }
) {
  // touch logfile and create folders
  await fs.mkdir(dirname(options.logFile), { recursive: true })
  await fs.mkdir(options.outDirectory, { recursive: true })
  closeSync(openSync(options.logFile, 'w'))

  // normalize content server URL
  let contentServerUrl = options.contentServerUrl
  if (!contentServerUrl.endsWith('/')) contentServerUrl += '/'
  contentServerUrl += 'contents/'

  const childArg0 = `${options.unityPath}/Editor/Unity`
  const childArguments: string[] = [
    '-projectPath', options.projectPath,
    '-batchmode',
    '-executeMethod', 'DCL.ABConverter.SceneClient.ExportSceneToAssetBundles',
    '-sceneCid', options.entityId,
    '-logFile', options.logFile,
    '-baseUrl', contentServerUrl,
    '-output', options.outDirectory
  ]

  const { exitPromise, child } = execCommand(logger, childArg0, childArguments, process.env as any, options.projectPath)

  const failFuture = future<void>()

  if (options.timeout) {
    setTimeout(() => {
      if (!child.killed) {
        try {
          failFuture.reject(new Error('Process did not finish'))
          logger.warn('Process did not finish, printing log', { pid: child.pid?.toString() || '?', command: childArg0, args: childArguments.join(' ') } as any)
          logger.debug(readFileSync(options.logFile, 'utf8'))
          components.metrics.increment('ab_converter_timeout')
          if (!child.kill('SIGKILL')) {
            logger.error('Error trying to kill child process', { pid: child.pid?.toString() || '?', command: childArg0, args: childArguments.join(' ') } as any)
            setTimeout(() => {
              // kill the process in one minute, enough time to allow prometheus to collect the metrics
              process.exit(1)
            }, 60_000)
          }
        } catch (err: any) {
          failFuture.reject(err)
          logger.error(err)
        }
      }
    }, options.timeout)
  }

  return await Promise.race([exitPromise, failFuture])
}