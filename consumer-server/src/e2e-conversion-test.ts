// End-to-end test: resolve a Decentraland scene, run the full conversion
// pipeline (real Unity, mock-aws-s3), then verify every bundle listed in the
// manifest exists in the mock S3 store and is non-empty.
//
// Works with both regular catalysts (--coords) and the worlds content server (--world).
//
// Usage (inside the Docker image):
//   node dist/e2e-conversion-test.js --world ABTestScene1.dcl.eth --coords 0,0
//   node dist/e2e-conversion-test.js --coords 43,100 --baseUrl https://peer.decentraland.org/content

import arg from 'arg'
import * as fs from 'fs'
import * as path from 'path'
import MockAws from 'mock-aws-s3'
import { createConfigComponent } from '@well-known-components/env-config-provider'
import { createLogComponent } from '@well-known-components/logger'
import { createMetricsComponent } from '@well-known-components/metrics'
import { metricDeclarations } from './metrics'
import { getEntities } from './logic/fetch-entity-by-pointer'
import { createFetchComponent } from './adapters/fetch'
import { executeConversion } from './logic/conversion-task'
import { getAbVersionEnvName } from './utils'
import { ensureUlf } from './logic/ensure-ulf'

const args = arg({
  '--world': String,
  '--coords': String,
  '--baseUrl': String
})

if (!args['--coords']) {
  throw new Error('--coords <x,y> is required (e.g. --coords 0,0)')
}

const WORLD_NAME = args['--world']
const COORDS = args['--coords']
const BASE_URL =
  args['--baseUrl'] ||
  (WORLD_NAME ? 'https://worlds-content-server.decentraland.zone' : 'https://peer.decentraland.zone/content')

const $UNITY_PATH = process.env.UNITY_PATH
const $PROJECT_PATH = process.env.PROJECT_PATH
const $BUILD_TARGET = process.env.BUILD_TARGET || 'webgl'

if (!$UNITY_PATH) throw new Error('UNITY_PATH env var is not defined')
if (!$PROJECT_PATH) throw new Error('PROJECT_PATH env var is not defined')

const MOCK_S3_BASE = '/tmp/e2e-mock-s3'
const BUCKET_NAME = 'e2e-test-bucket'

async function main() {
  ensureUlf()

  // Set up mock-aws-s3 with a clean temp directory
  fs.mkdirSync(MOCK_S3_BASE, { recursive: true })
  MockAws.config.basePath = MOCK_S3_BASE
  const cdnS3 = new MockAws.S3({ params: { Bucket: BUCKET_NAME } })

  const abVersionEnvName = getAbVersionEnvName($BUILD_TARGET)

  const config = createConfigComponent({
    UNITY_PATH: $UNITY_PATH!,
    PROJECT_PATH: $PROJECT_PATH!,
    BUILD_TARGET: $BUILD_TARGET,
    [abVersionEnvName]: process.env[abVersionEnvName] || 'v48',
    AB_VERSION: process.env.AB_VERSION || '',
    AB_VERSION_WINDOWS: process.env.AB_VERSION_WINDOWS || '',
    AB_VERSION_MAC: process.env.AB_VERSION_MAC || '',
    ASSET_REUSE_ENABLED: 'true',
    CDN_BUCKET: BUCKET_NAME,
    LOGS_BUCKET: ''
  })
  const metrics = await createMetricsComponent(metricDeclarations, { config })
  const logs = await createLogComponent({ metrics })
  const logger = logs.getLogger('e2e-conversion-test')
  const sentry = { captureMessage: () => {}, captureException: () => {} } as any

  const fetcher = await createFetchComponent()

  // --- Step 1: Resolve to entity CID ---
  let entityId: string

  if (WORLD_NAME) {
    // Fetch the world's scene list and find the scene that contains the requested coords.
    const scenesUrl = `${BASE_URL}/world/${WORLD_NAME}/scenes`
    logger.info(`Fetching world scenes from ${scenesUrl}`)
    const scenesRes = await fetcher.fetch(scenesUrl)
    if (!scenesRes.ok) {
      throw new Error(`Failed to fetch world scenes: ${scenesRes.status} ${scenesRes.statusText}`)
    }
    const scenesBody = await scenesRes.json()
    const scenes = (scenesBody as any).scenes as any[]
    if (!scenes?.length) {
      throw new Error(`World "${WORLD_NAME}" has no scenes`)
    }

    const scene = scenes.find((s: any) => s.parcels?.includes(COORDS))
    if (!scene) {
      const available = scenes.map((s: any) => s.parcels?.join(', ')).join(' | ')
      throw new Error(`Coords "${COORDS}" not found in world "${WORLD_NAME}". Available parcels: ${available}`)
    }

    entityId = scene.entityId
    logger.info(`World "${WORLD_NAME}" scene at ${COORDS} → entityId=${entityId}`)
  } else {
    logger.info(`Resolving coords "${COORDS}" via ${BASE_URL}`)
    const entities = await getEntities(fetcher, [COORDS], BASE_URL)
    if (!entities.length) {
      throw new Error(`Could not resolve coords "${COORDS}" at ${BASE_URL}`)
    }
    entityId = entities[0].id
    logger.info(`Resolved to entityId=${entityId}`)
  }

  // --- Step 2: Run the full conversion pipeline ---
  const abVersion = await config.requireString(abVersionEnvName)
  logger.info(`Starting conversion: abVersion=${abVersion}, buildTarget=${$BUILD_TARGET}`)

  const exitCode = await executeConversion(
    { logs, metrics, config, cdnS3, sentry },
    entityId,
    BASE_URL,
    /* force */ false,
    /* animation */ 'legacy',
    /* doISS */ false,
    abVersion
  )

  logger.info(`Conversion finished with exitCode=${exitCode}`)
  if (exitCode !== 0 && exitCode !== 2) {
    // 0 = success, 2 = CONVERSION_ERRORS_TOLERATED
    throw new Error(`Conversion failed with exitCode=${exitCode}`)
  }

  // --- Step 3: Read the manifest from mock S3 ---
  const manifestKey =
    $BUILD_TARGET !== 'webgl' ? `manifest/${entityId}_${$BUILD_TARGET}.json` : `manifest/${entityId}.json`

  let manifestBody: string
  try {
    const res = await cdnS3.getObject({ Bucket: BUCKET_NAME, Key: manifestKey }).promise()
    manifestBody = res.Body!.toString()
  } catch (err: any) {
    throw new Error(`Manifest not found at ${manifestKey}: ${err.message}`)
  }

  const manifest = JSON.parse(manifestBody)
  logger.info(`Manifest lists ${manifest.files.length} bundle(s)`)

  if (!manifest.files.length) {
    throw new Error('Manifest has zero files — conversion produced no bundles')
  }

  // --- Step 4: Verify each bundle exists in mock S3 ---
  // Bundles land at the canonical path (`{abVersion}/assets/`) when asset reuse
  // is active, or at the entity-scoped path (`{abVersion}/{entityId}/`) when it
  // isn't (e.g. worlds content server doesn't support getActiveEntity by ID, so
  // the entity fetch inside executeConversion fails and reuse is disabled).
  // Check both locations so the test works regardless.
  const canonicalPrefix = `${abVersion}/assets`
  const entityScopedPrefix = `${abVersion}/${entityId}`
  let failures = 0

  for (const bundleFilename of manifest.files) {
    const canonicalKey = `${canonicalPrefix}/${bundleFilename}`
    const entityScopedKey = `${entityScopedPrefix}/${bundleFilename}`
    const canonicalPath = path.join(MOCK_S3_BASE, BUCKET_NAME, canonicalKey)
    const entityScopedPath = path.join(MOCK_S3_BASE, BUCKET_NAME, entityScopedKey)

    const foundPath = fs.existsSync(canonicalPath)
      ? canonicalPath
      : fs.existsSync(entityScopedPath)
        ? entityScopedPath
        : null

    if (!foundPath) {
      logger.error(`MISSING bundle (checked ${canonicalKey} and ${entityScopedKey})`)
      failures++
      continue
    }

    const stat = fs.statSync(foundPath)
    if (stat.size === 0) {
      logger.error(`EMPTY bundle (0 bytes): ${foundPath}`)
      failures++
      continue
    }

    const usedKey = foundPath === canonicalPath ? canonicalKey : entityScopedKey
    logger.info(`OK: ${usedKey} (${stat.size} bytes)`)
  }

  // --- Summary ---
  if (failures > 0) {
    throw new Error(`${failures} bundle(s) missing or empty out of ${manifest.files.length}`)
  }

  logger.info(`All ${manifest.files.length} bundle(s) verified successfully`)
}

main()
  .then(() => {
    process.exit(0)
  })
  .catch((err) => {
    console.error('E2E FAILED:', err)
    process.exit(1)
  })
