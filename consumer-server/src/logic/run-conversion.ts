import { ILoggerComponent } from '@well-known-components/interfaces'
import { closeSync, openSync } from 'fs'
import * as fs from 'fs/promises'
import { dirname } from 'path'
import { AppComponents } from '../types'
import { execCommand } from './run-command'
import { spawn } from 'child_process'

async function setupStartDirectories(options: { logFile: string; outDirectory: string; projectPath: string }) {
  // touch logfile and create folders
  await fs.mkdir(dirname(options.logFile), { recursive: true })
  await fs.mkdir(options.outDirectory, { recursive: true })
  closeSync(openSync(options.logFile, 'w'))
}

export function startManifestBuilder(sceneId: string, outputPath: string, catalyst: string) {
  const cmd = process.platform === 'win32' ? 'npm.cmd' : 'npm'
  const child = spawn(
    cmd,
    [
      'run',
      'start',
      `--sceneid=${sceneId}`,
      `--output=${outputPath}`,
      `--catalyst=${catalyst}`,
      '--prefix',
      '../scene-lod-entities-manifest-builder'
    ],
    {
      stdio: 'inherit',
      env: process.env
    }
  )

  return new Promise<void>((resolve, reject) => {
    child.on('close', (code) => {
      if (code !== 0) {
        console.error(`scene-lod-entities-manifest-builder exited with ${code}`)
        reject(new Error(`Process exited with code ${code}`))
      } else {
        resolve()
      }
    })
  })
}

async function executeProgram(options: {
  logger: ILoggerComponent.ILogger
  components: Pick<AppComponents, 'metrics'>
  childArg0: string
  childArguments: string[]
  projectPath: string
  timeout: number
}) {
  const { logger, components, childArg0, childArguments, projectPath, timeout } = options
  const { exitPromise, child } = execCommand(logger, childArg0, childArguments, process.env as any, projectPath)

  if (timeout) {
    setTimeout(() => {
      if (exitPromise.isPending) {
        try {
          if (!child.killed) {
            logger.warn('Process did not finish', {
              pid: child.pid?.toString() || '?',
              command: childArg0,
              args: childArguments.join(' ')
            } as any)
            components.metrics.increment('ab_converter_timeout')
            exitPromise.reject(new Error('Process did not finish'))
            if (!child.kill('SIGKILL')) {
              logger.error('Error trying to kill child process', {
                pid: child.pid?.toString() || '?',
                command: childArg0,
                args: childArguments.join(' ')
              } as any)
            }
          }
        } catch (err: any) {
          logger.error(err)
        }
      }
    }, timeout)
  }

  return exitPromise
}

export async function runLodsConversion(
  logger: ILoggerComponent.ILogger,
  components: Pick<AppComponents, 'metrics'>,
  options: {
    logFile: string
    outDirectory: string
    entityId: string
    lods: string[]
    unityPath: string
    projectPath: string
    timeout: number
    unityBuildTarget: string
  }
) {
  await setupStartDirectories(options)

  const childArg0 = `${options.unityPath}/Editor/Unity`

  const childArguments: string[] = [
    '-projectPath',
    options.projectPath,
    '-batchmode',
    '-executeMethod',
    'DCL.ABConverter.LODClient.ExportURLLODsToAssetBundles',
    '-sceneCid',
    options.entityId,
    '-logFile',
    options.logFile,
    '-lods',
    options.lods.join(';'),
    '-output',
    options.outDirectory,
    '-buildTarget',
    options.unityBuildTarget,
    '-deleteDownloadPathAfterFinished'
  ]

  return await executeProgram({
    logger,
    components,
    childArg0,
    childArguments,
    projectPath: options.projectPath,
    timeout: options.timeout
  })
}

export async function runConversion(
  logger: ILoggerComponent.ILogger,
  components: Pick<AppComponents, 'metrics'>,
  options: {
    logFile: string
    outDirectory: string
    entityId: string
    entityType: string
    contentServerUrl: string
    unityPath: string
    projectPath: string
    timeout: number
    unityBuildTarget: string
    animation: string | undefined
    doISS: boolean | undefined
  }
) {
  await setupStartDirectories(options)

  // Run manifest builder before conversion if needed
  if (options.entityType === 'scene' && options.unityBuildTarget !== 'WebGL' && options.doISS) {
    try {
      const catalystDomain = new URL(options.contentServerUrl).origin
      await startManifestBuilder(options.entityId, options.projectPath + '/Assets/_SceneManifest', catalystDomain)
    } catch (e) {
      logger.error('Failed to generate scene manifest, building without ISS')
    }
  }

  // normalize content server URL
  let contentServerUrl = options.contentServerUrl
  if (!contentServerUrl.endsWith('/')) contentServerUrl += '/'

  // TODO: Temporal hack, we need to standardize this
  if (contentServerUrl !== 'https://sdk-team-cdn.decentraland.org/ipfs/' && !contentServerUrl.endsWith('contents/')) {
    contentServerUrl += 'contents/'
  }

  //TODO (JUANI): ASK ABOUT THIS PATH, NOT SURE HOW THIS WORKS
  const childArg0 = `${options.unityPath}/Editor/Unity`

  const childArguments: string[] = [
    '-projectPath',
    options.projectPath,
    '-batchmode',
    '-executeMethod',
    'DCL.ABConverter.SceneClient.ExportSceneToAssetBundles',
    '-sceneCid',
    options.entityId,
    '-logFile',
    options.logFile,
    '-baseUrl',
    contentServerUrl,
    '-output',
    options.outDirectory,
    '-buildTarget',
    options.unityBuildTarget,
    '-animation',
    options.animation || 'legacy'
  ]

  return await executeProgram({
    logger,
    components,
    childArg0,
    childArguments,
    projectPath: options.projectPath,
    timeout: options.timeout
  })
}
