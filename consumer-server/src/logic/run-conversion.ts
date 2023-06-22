import { ILoggerComponent } from '@well-known-components/interfaces'
import { closeSync, openSync } from 'fs'
import * as fs from 'fs/promises'
import { dirname } from 'path'
import { AppComponents } from '../types'
import { execCommand } from './run-command'

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
    '-output', options.outDirectory,
  ]

  const { exitPromise, child } = execCommand(logger, childArg0, childArguments, process.env as any, options.projectPath)

  if (options.timeout) {
    setTimeout(() => {
      if (exitPromise.isPending) {
        try {
          if (!child.killed) {
            logger.warn('Process did not finish', { pid: child.pid?.toString() || '?', command: childArg0, args: childArguments.join(' ') } as any)
            components.metrics.increment('ab_converter_timeout')
            exitPromise.reject(new Error('Process did not finish'))
            if (!child.kill('SIGKILL')) {
              logger.error('Error trying to kill child process', { pid: child.pid?.toString() || '?', command: childArg0, args: childArguments.join(' ') } as any)
            }
          }
        } catch (err: any) {
          logger.error(err)
        }
      }
    }, options.timeout)
  }

  return await exitPromise
}