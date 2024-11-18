import { uploadDir } from '@dcl/cdn-uploader'
import { FileVariant } from '@dcl/cdn-uploader/dist/types'
import * as promises from 'fs/promises'
import { rimraf } from 'rimraf'
import { AppComponents } from '../types'
import { runConversion, runLodsConversion } from './run-conversion'
import * as fs from 'fs'
import * as path from 'path'
import { hasContentChange } from './has-content-changed-task'

type Manifest = {
  version: string
  files: string[]
  exitCode: number | null
  contentServerUrl?: string
  date: string
}

async function getCdnBucket(components: Pick<AppComponents, 'config'>) {
  return (await components.config.getString('CDN_BUCKET')) || 'CDN_BUCKET'
}

function manifestKeyForEntity(entityId: string, target: string | undefined) {
  if (target && target !== 'webgl') {
    return `manifest/${entityId}_${target}.json`
  } else {
    return `manifest/${entityId}.json`
  }
}

// returns true if the asset was converted and uploaded with the same version of the converter
async function shouldIgnoreConversion(
  components: Pick<AppComponents, 'logs' | 'metrics' | 'config' | 'cdnS3'>,
  $AB_VERSION: string,
  entityId: string,
  target: string | undefined
): Promise<boolean> {
  const cdnBucket = await getCdnBucket(components)
  const manifestFile = manifestKeyForEntity(entityId, target)

  try {
    const obj = await components.cdnS3.getObject({ Bucket: cdnBucket, Key: manifestFile }).promise()
    if (!obj.Body) return false
    const json: Manifest = JSON.parse(obj.Body?.toString())

    // not ignored when previous run had exit code
    if (json.exitCode) return false

    // ignored only when previous version is the same as current version
    if (json.version === $AB_VERSION) return true
  } catch {}

  return false
}

export function getUnityBuildTarget(target: string): string | undefined {
  switch (target) {
    case 'webgl':
      return 'WebGL'
    case 'windows':
      return 'StandaloneWindows64'
    case 'mac':
      return 'StandaloneOSX'
    default:
      return undefined
  }
}

function getAbVersionEnvName(buildTarget: string) {
  switch (buildTarget) {
    case 'webgl':
      return 'AB_VERSION'
    case 'windows':
      return 'AB_VERSION_WINDOWS'
    case 'mac':
      return 'AB_VERSION_MAC'
    default:
      throw 'Invalid buildTarget'
  }
}

export async function executeLODConversion(
  components: Pick<AppComponents, 'logs' | 'metrics' | 'config' | 'cdnS3'>,
  entityId: string,
  lods: string[]
) {
  const $LOGS_BUCKET = await components.config.getString('LOGS_BUCKET')
  const $UNITY_PATH = await components.config.requireString('UNITY_PATH')
  const $PROJECT_PATH = await components.config.requireString('PROJECT_PATH')
  const $BUILD_TARGET = await components.config.requireString('BUILD_TARGET')

  const abVersionEnvName = getAbVersionEnvName($BUILD_TARGET)
  const unityBuildTarget = getUnityBuildTarget($BUILD_TARGET)

  const $AB_VERSION = await components.config.requireString(abVersionEnvName)
  const logger = components.logs.getLogger(`ExecuteConversion`)

  const cdnBucket = await getCdnBucket(components)
  const logFile = `/tmp/lods_logs/export_log_${entityId}_${Date.now()}.txt`
  const s3LogKey = `logs/lods/${$AB_VERSION}/${entityId}/${new Date().toISOString()}.txt`
  const outDirectory = `/tmp/lods_contents/entity_${entityId}`
  const defaultLoggerMetadata = { entityId, lods, version: $AB_VERSION, logFile } as any

  logger.info('Starting conversion for ' + $BUILD_TARGET, defaultLoggerMetadata)

  if (!unityBuildTarget) {
    logger.error('Could not find a build target', { ...defaultLoggerMetadata } as any)
    return
  }

  try {
    const exitCode = await runLodsConversion(logger, components, {
      entityId,
      logFile,
      outDirectory,
      lods,
      unityPath: $UNITY_PATH,
      projectPath: $PROJECT_PATH,
      timeout: 60 * 60 * 1000,
      unityBuildTarget
    })

    components.metrics.increment('ab_converter_exit_codes', { exit_code: (exitCode ?? -1)?.toString() })

    const generatedFiles = await promises.readdir(outDirectory)

    if (generatedFiles.length === 0) {
      // this is an error, if succeeded, we should see at least a manifest file
      components.metrics.increment('ab_converter_empty_conversion', { ab_version: $AB_VERSION })
      logger.error('Empty conversion', { ...defaultLoggerMetadata } as any)
      return
    }

    await uploadDir(components.cdnS3, cdnBucket, outDirectory, 'LOD', {
      concurrency: 10,
      matches: [
        {
          // the rest of the elements will be uploaded as application/wasm
          // to be compressed and cached by cloudflare
          match: '**/*',
          contentType: 'application/wasm',
          immutable: true,
          variants: [FileVariant.Brotli, FileVariant.Uncompressed],
          skipRepeated: true
        }
      ]
    })
  } catch (error: any) {
    logger.debug(await promises.readFile(logFile, 'utf8'), defaultLoggerMetadata)
    components.metrics.increment('ab_converter_exit_codes', { exit_code: 'FAIL' })
    logger.error(error)

    setTimeout(() => {
      // kill the process in one minute, enough time to allow prometheus to collect the metrics
      process.exit(199)
    }, 60_000)

    throw error
  } finally {
    if ($LOGS_BUCKET) {
      const log = `https://${$LOGS_BUCKET}.s3.amazonaws.com/${s3LogKey}`

      logger.info(`LogFile=${log}`, defaultLoggerMetadata)
      await components.cdnS3
        .upload({
          Bucket: $LOGS_BUCKET,
          Key: s3LogKey,
          Body: await promises.readFile(logFile),
          ACL: 'public-read'
        })
        .promise()
    } else {
      logger.info(`!!!!!!!! Log file not deleted or uploaded ${logFile}`, defaultLoggerMetadata)
    }

    // delete output files
    try {
      await rimraf(logFile, { maxRetries: 3 })
    } catch (err: any) {
      logger.error(err, defaultLoggerMetadata)
    }
    try {
      await rimraf(outDirectory, { maxRetries: 3 })
    } catch (err: any) {
      logger.error(err, defaultLoggerMetadata)
    }
    // delete library folder
    try {
      await rimraf(`${$PROJECT_PATH}/Library`, { maxRetries: 3 })
    } catch (err: any) {
      logger.error(err, defaultLoggerMetadata)
    }
  }

  logger.debug('LOD Conversion finished', defaultLoggerMetadata)
}

export async function executeConversion(
  components: Pick<AppComponents, 'logs' | 'metrics' | 'config' | 'cdnS3' | 'sentry'>,
  entityId: string,
  contentServerUrl: string,
  force: boolean | undefined,
  animation: string | undefined
) {
  const $LOGS_BUCKET = await components.config.getString('LOGS_BUCKET')
  const $UNITY_PATH = await components.config.requireString('UNITY_PATH')
  const $PROJECT_PATH = await components.config.requireString('PROJECT_PATH')
  const $BUILD_TARGET = await components.config.requireString('BUILD_TARGET')

  const abVersionEnvName = getAbVersionEnvName($BUILD_TARGET)
  const $AB_VERSION = await components.config.requireString(abVersionEnvName)
  const logger = components.logs.getLogger(`ExecuteConversion`)

  const unityBuildTarget = getUnityBuildTarget($BUILD_TARGET)
  if (!unityBuildTarget) {
    logger.info('Invalid build target ' + $BUILD_TARGET)
    return
  }

  if (!force) {
    if (await shouldIgnoreConversion(components, entityId, $AB_VERSION, $BUILD_TARGET)) {
      logger.info('Ignoring conversion', { entityId, contentServerUrl, $AB_VERSION })
      return
    }
  } else {
    logger.info('Forcing conversion', { entityId, contentServerUrl, $AB_VERSION })
  }

  const cdnBucket = await getCdnBucket(components)
  const manifestFile = manifestKeyForEntity(entityId, $BUILD_TARGET)
  const failedManifestFile = `manifest/${entityId}_failed.json`

  const logFile = `/tmp/asset_bundles_logs/export_log_${entityId}_${Date.now()}.txt`
  const s3LogKey = `logs/${$AB_VERSION}/${entityId}/${new Date().toISOString()}.txt`
  const outDirectory = `/tmp/asset_bundles_contents/entity_${entityId}`

  const defaultLoggerMetadata = { entityId, contentServerUrl, version: $AB_VERSION, logFile: s3LogKey }

  logger.info('Starting conversion for ' + $BUILD_TARGET, defaultLoggerMetadata)
  let hasContentChanged = true

  if ($BUILD_TARGET !== 'webgl') {
    try {
      hasContentChanged = await hasContentChange(
        entityId,
        contentServerUrl,
        $BUILD_TARGET,
        outDirectory,
        $AB_VERSION,
        logger
      )
    } catch (e) {
      logger.info('HasContentChanged failed with error ' + e)
    }
  }

  logger.info(`HasContentChanged for ${entityId} result was ${hasContentChanged}`)

  let exitCode
  try {
    if (hasContentChanged) {
      exitCode = await runConversion(logger, components, {
        contentServerUrl,
        entityId,
        logFile,
        outDirectory,
        projectPath: $PROJECT_PATH,
        unityPath: $UNITY_PATH,
        timeout: 120 * 60 * 1000, // 120min temporarily doubled
        unityBuildTarget: unityBuildTarget,
        animation: animation
      })
    } else {
      exitCode = 0
    }

    components.metrics.increment('ab_converter_exit_codes', { exit_code: (exitCode ?? -1)?.toString() })

    const manifest: Manifest = {
      version: $AB_VERSION,
      files: await promises.readdir(outDirectory),
      exitCode,
      contentServerUrl,
      date: new Date().toISOString()
    }

    logger.debug('Manifest', { ...defaultLoggerMetadata, manifest } as any)

    if (manifest.files.length === 0) {
      // this is an error, if succeeded, we should see at least a manifest file
      components.metrics.increment('ab_converter_empty_conversion', { ab_version: $AB_VERSION })
      logger.error('Empty conversion', { ...defaultLoggerMetadata, manifest } as any)
    }

    let uploadPath: string = ''
    if ($BUILD_TARGET === 'webgl') {
      uploadPath = $AB_VERSION
    } else {
      uploadPath = $AB_VERSION + '/' + entityId
    }

    // first upload the content
    await uploadDir(components.cdnS3, cdnBucket, outDirectory, uploadPath, {
      concurrency: 10,
      matches: [
        {
          match: '**/*.manifest',
          contentType: 'text/cache-manifest',
          immutable: true,
          variants: [FileVariant.Brotli, FileVariant.Uncompressed]
        },
        {
          // the rest of the elements will be uploaded as application/wasm
          // to be compressed and cached by cloudflare
          match: '**/*',
          contentType: 'application/wasm',
          immutable: true,
          variants: [FileVariant.Brotli, FileVariant.Uncompressed],
          skipRepeated: true
        }
      ]
    })

    logger.debug('Content files uploaded', defaultLoggerMetadata)

    // and then replace the manifest
    await components.cdnS3
      .upload({
        Bucket: cdnBucket,
        Key: manifestFile,
        ContentType: 'application/json',
        Body: JSON.stringify(manifest),
        CacheControl: 'private, max-age=0, no-cache',
        ACL: 'public-read'
      })
      .promise()

    if (exitCode !== 0 || manifest.files.length === 0) {
      const log = await promises.readFile(logFile, 'utf8')

      logger.debug(log, defaultLoggerMetadata)

      if (log.includes('You must have a valid X server running')) {
        // if X server is having trouble, we will kill the service right away. without further ado
        // this will make the job to timeout and to be re-processed by the SQS queue
        logger.error('X server is having trouble, the service will restart')
        process.exit(1)
      }
    }
  } catch (err: any) {
    logger.debug(await promises.readFile(logFile, 'utf8'), defaultLoggerMetadata)
    components.metrics.increment('ab_converter_exit_codes', { exit_code: 'FAIL' })
    logger.error(err)

    components.sentry.captureMessage(`Error during ab conversion`, {
      level: 'error',
      tags: {
        entityId,
        contentServerUrl,
        unityBuildTarget,
        unityExitCode: exitCode || 'unknown',
        version: $AB_VERSION,
        log: s3LogKey,
        date: new Date().toISOString()
      }
    })

    try {
      // and then replace the manifest
      await components.cdnS3
        .upload({
          Bucket: cdnBucket,
          Key: failedManifestFile,
          ContentType: 'application/json',
          Body: JSON.stringify({
            entityId,
            contentServerUrl,
            version: $AB_VERSION,
            log: s3LogKey,
            date: new Date().toISOString()
          }),
          CacheControl: 'max-age=3600,s-maxage=3600',
          ACL: 'public-read'
        })
        .promise()
    } catch {}

    setTimeout(() => {
      // kill the process in one minute, enough time to allow prometheus to collect the metrics
      process.exit(199)
    }, 60_000)

    throw err
  } finally {
    if ($LOGS_BUCKET && hasContentChanged) {
      const log = `https://${$LOGS_BUCKET}.s3.amazonaws.com/${s3LogKey}`

      logger.info(`LogFile=${log}`, defaultLoggerMetadata)
      await components.cdnS3
        .upload({
          Bucket: $LOGS_BUCKET,
          Key: s3LogKey,
          Body: await promises.readFile(logFile),
          ACL: 'public-read'
        })
        .promise()
    } else {
      logger.info(`!!!!!!!! Log file not deleted or uploaded ${logFile}`, defaultLoggerMetadata)
    }

    // delete output files
    try {
      await rimraf(logFile, { maxRetries: 3 })
    } catch (err: any) {
      logger.error(err, defaultLoggerMetadata)
    }
    try {
      await rimraf(outDirectory, { maxRetries: 3 })
    } catch (err: any) {
      logger.error(err, defaultLoggerMetadata)
    }
    // delete library folder
    try {
      await rimraf(`${$PROJECT_PATH}/Library`, { maxRetries: 3 })
    } catch (err: any) {
      logger.error(`Error deleting library folder: ${err}`, defaultLoggerMetadata)
    }
    //delete _Download folder
    try {
      await rimraf(`${$PROJECT_PATH}/Assets/_Downloaded`, { maxRetries: 3 })
    } catch (err: any) {
      logger.error(err, defaultLoggerMetadata)
    }
  }

  logger.debug('Conversion finished', defaultLoggerMetadata)
  logger.debug(`Full project size ${getFolderSize($PROJECT_PATH)}`)
  printFolderSizes($PROJECT_PATH, logger)
}

/**
 * Recursively calculates the size of a directory in bytes.
 * @param dirPath - The path to the directory.
 * @returns The size of the directory in bytes.
 */
function getFolderSize(dirPath: string): number {
  let totalSize = 0

  const files = fs.readdirSync(dirPath)
  for (const file of files) {
    const filePath = path.join(dirPath, file)
    const stats = fs.statSync(filePath)

    if (stats.isDirectory()) {
      totalSize += getFolderSize(filePath) // Recursively add the size of subdirectories
    } else {
      totalSize += stats.size
    }
  }

  return totalSize
}

/**
 * Recursively iterates through each folder and subfolder, printing its size.
 * @param dirPath - The path to the directory.
 * @param logger - The used logger.
 * @param depth - The max depth of folder size logging.
 */
function printFolderSizes(dirPath: string, logger: any, depth: number = 0): void {
  const stats = fs.statSync(dirPath)

  if (stats.isDirectory()) {
    const folderSize = getFolderSize(dirPath)
    logger.debug(`Unity Folder: ${dirPath} - Size: ${(folderSize / (1024 * 1024)).toFixed(2)} MB`)

    if (depth < 2) {
      const files = fs.readdirSync(dirPath)
      for (const file of files) {
        const filePath = path.join(dirPath, file)
        if (fs.statSync(filePath).isDirectory()) {
          printFolderSizes(filePath, logger, depth + 1) // Increment depth by 1 for the next level
        }
      }
    }
  }
}
