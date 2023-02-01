import { ILoggerComponent } from '@well-known-components/interfaces'
import { closeSync, openSync } from 'fs'
import * as fs from 'fs/promises'
import { dirname } from 'path'
import { execCommand } from './run-command'

export async function runConversion(
  logger: ILoggerComponent.ILogger,
  options: {
    logFile: string,
    outDirectory: string,
    entityId: string,
    contentServerUrl: string,
    unityPath: string,
    projectPath: string,
    timeout?: number
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

  const { exitPromise } = execCommand(logger, childArg0, childArguments, process.env as any, options.projectPath, options.timeout)

  return await exitPromise
}