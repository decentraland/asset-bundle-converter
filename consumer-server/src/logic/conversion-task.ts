import { uploadDir } from '@dcl/cdn-uploader'
import * as promises from 'fs/promises'
import { rimraf } from 'rimraf'
import { AppComponents } from '../types'
import { runConversion } from './run-conversion'


export async function executeConversion(components: Pick<AppComponents, 'logs' | 'metrics' | 'config' | 'cdnS3'>, entityId: string, contentServerUrl: string) {
  const $AB_VERSION = await components.config.requireString('AB_VERSION')
  const $LOGS_BUCKET = await components.config.getString('LOGS_BUCKET')
  const $UNITY_PATH = await components.config.requireString('UNITY_PATH')
  const $PROJECT_PATH = await components.config.requireString('PROJECT_PATH')

  const cdnBucket = await components.config.getString('CDN_BUCKET') || 'CDN_BUCKET'

  const logFile = `/tmp/asset_bundles_logs/export_log_${entityId}_${Date.now()}.txt`
  const s3LogKey = `logs/${$AB_VERSION}/${entityId}/${new Date().toISOString()}.txt`
  const outDirectory = `/tmp/asset_bundles_contents/entity_${entityId}`

  const logger = components.logs.getLogger(`ExecuteConversion`)

  const defaultLoggerMetadata = { entityId, contentServerUrl, version: $AB_VERSION }

  logger.debug("Starting conversion", defaultLoggerMetadata)

  try {
    const exitCode = await runConversion(logger, components, {
      contentServerUrl,
      entityId,
      logFile,
      outDirectory,
      projectPath: $PROJECT_PATH,
      unityPath: $UNITY_PATH,
      timeout: 30 * 60 * 1000 // 30min
    })

    components.metrics.increment('ab_converter_exit_codes', { exit_code: (exitCode ?? -1)?.toString() })

    const manifest = {
      version: $AB_VERSION,
      files: await promises.readdir(outDirectory),
      exitCode
    } as const

    logger.debug('Manifest', { ...defaultLoggerMetadata, manifest } as any)

    if (manifest.files.length == 0) {
      // this is an error, if succeeded, we should see at least a manifest file
      components.metrics.increment('ab_converter_empty_conversion', { ab_version: $AB_VERSION })
      logger.error('Empty conversion', { ...defaultLoggerMetadata, manifest } as any)
    }

    // first upload the content
    await uploadDir(components.cdnS3, cdnBucket, outDirectory, $AB_VERSION, {
      concurrency: 10,
      immutable: true,
      matches: [
        {
          match: "**/*.manifest",
          contentType: "text/cache-manifest",
          immutable: true,
        },
        {
          // the rest of the elements will be uploaded as application/wasm
          // to be compressed and cached by cloudflare
          match: "**/*",
          contentType: "application/wasm",
          immutable: true,
        }
      ]
    })

    logger.debug('Content files uploaded', defaultLoggerMetadata)

    // and then replace the manifest
    await components.cdnS3.upload({
      Bucket: cdnBucket,
      Key: `manifest/${entityId}.json`,
      ContentType: 'application/json',
      Body: JSON.stringify(manifest),
      CacheControl: 'max-age=3600,s-maxage=3600',
      ACL: 'public-read',
    }).promise()

    if (exitCode !== 0 || manifest.files.length == 0) {
      logger.debug(await promises.readFile(logFile, 'utf8'), defaultLoggerMetadata)
    }
  } catch (err: any) {
    logger.debug(await promises.readFile(logFile, 'utf8'), defaultLoggerMetadata)
    components.metrics.increment('ab_converter_exit_codes', { exit_code: 'FAIL' })
    logger.error(err)

    setTimeout(() => {
      // kill the process in one minute, enough time to allow prometheus to collect the metrics
      process.exit(199)
    }, 60_000)
  } finally {
    if ($LOGS_BUCKET) {
      const log = `https://${$LOGS_BUCKET}.s3.amazonaws.com/${s3LogKey}`

      logger.info(`LogFile=${log}`, defaultLoggerMetadata)
      await components.cdnS3
        .upload({
          Bucket: $LOGS_BUCKET,
          Key: s3LogKey,
          Body: await promises.readFile(logFile),
          ACL: 'public-read',
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
  }

  logger.debug("Conversion finished", defaultLoggerMetadata)
}
