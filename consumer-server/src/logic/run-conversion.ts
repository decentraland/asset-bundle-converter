import { ILoggerComponent } from '@well-known-components/interfaces'
import { closeSync, openSync } from 'fs'
import * as fs from 'fs/promises'
import { dirname } from 'path'
import { AppComponents } from '../types'
import { execCommand } from './run-command'

async function makeLogFileAndOutputDirectoryAvailable(options: {
  logFile: string,
  outDirectory: string
}) {
  // touch logfile and create folders
  await fs.mkdir(dirname(options.logFile), { recursive: true })
  await fs.mkdir(options.outDirectory, { recursive: true })
  closeSync(openSync(options.logFile, 'w'))
}

async function executeProgram(options: { logger: ILoggerComponent.ILogger, components: Pick<AppComponents, 'metrics'>, childArg0: string, childArguments: string[], projectPath: string, timeout: number }) {
  const { logger, components, childArg0, childArguments, projectPath, timeout } = options
  const { exitPromise, child } = execCommand(logger, childArg0, childArguments, process.env as any, projectPath)

  if (timeout) {
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
    }, timeout)
  }

  return await exitPromise
}

export async function runLodsConversion(logger: ILoggerComponent.ILogger, components: Pick<AppComponents, 'metrics'>, options: {
  logFile: string,
  outDirectory: string,
  entityId: string,
  lods: string[],
  unityPath: string,
  projectPath: string,
  timeout: number,
  unityBuildTarget: string,
}) {
  makeLogFileAndOutputDirectoryAvailable(options)

  const childArg0 = `${options.unityPath}/Editor/Unity`

  const childArguments: string[] = [
    '-projectPath', options.projectPath,
    '-batchmode',
    '-executeMethod', 'DCL.ABConverter.LODClient.ExportURLLODsToAssetBundles',
    '-sceneCid', options.entityId,
    '-logFile', options.logFile,
    '-lods', options.lods.join(';'),
    '-output', options.outDirectory,
    '-buildTarget', options.unityBuildTarget
  ]

  return await executeProgram({ logger, components, childArg0, childArguments, projectPath: options.projectPath, timeout: options.timeout })
}

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
    timeout: number,
    unityBuildTarget: string,
  }
) {
  makeLogFileAndOutputDirectoryAvailable(options)

  // normalize content server URL
  let contentServerUrl = options.contentServerUrl
  if (!contentServerUrl.endsWith('/')) contentServerUrl += '/'

  // TODO: Temporal hack, we need to standardize this
  if (contentServerUrl !== 'https://sdk-team-cdn.decentraland.org/ipfs/' &&
      !contentServerUrl.endsWith('contents/')) {
    contentServerUrl += 'contents/'
  }

  const childArg0 = `${options.unityPath}/Editor/Unity`

  const childArguments: string[] = [
    '-projectPath', options.projectPath,
    '-batchmode',
    '-executeMethod', 'DCL.ABConverter.SceneClient.ExportSceneToAssetBundles',
    '-sceneCid', options.entityId,
    '-logFile', options.logFile,
    '-baseUrl', contentServerUrl,
    '-output', options.outDirectory,
    '-buildTarget', options.unityBuildTarget
  ]

  return await executeProgram({ logger, components, childArg0, childArguments, projectPath: options.projectPath, timeout: options.timeout })
}