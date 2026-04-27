// End-to-end test: convert one or more Decentraland scenes through the full
// pipeline (real Unity, mock-aws-s3), then verify every bundle listed in each
// manifest exists in the mock S3 store and is non-empty.
//
// When two scenes share assets, the second conversion should reuse cached
// bundles from the first — exercising the depsDigest deduplication logic.
//
// Usage (inside the Docker image):
//   node dist/e2e-conversion-test.js --world ABTestScene1.dcl.eth --coords 0,0
//   node dist/e2e-conversion-test.js --world ABTestScene1.dcl.eth --coords 0,0 --world2 ABTestScene2.dcl.eth --coords2 0,0
//   node dist/e2e-conversion-test.js --coords 43,100 --baseUrl https://peer.decentraland.zone/content

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
import { IFetchComponent } from '@well-known-components/interfaces'

const args = arg({
  '--world': String,
  '--coords': String,
  '--world2': String,
  '--coords2': String,
  '--baseUrl': String
})

if (!args['--coords']) {
  throw new Error('--coords <x,y> is required (e.g. --coords 0,0)')
}

const WORLD_NAME = args['--world']
const COORDS = args['--coords']
const WORLD_NAME_2 = args['--world2']
const COORDS_2 = args['--coords2']
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

type Manifest = { version: string; files: string[]; exitCode: number | null }

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function resolveWorldEntity(
  fetcher: IFetchComponent,
  worldName: string,
  coords: string,
  baseUrl: string
): Promise<string> {
  const scenesUrl = `${baseUrl}/world/${worldName}/scenes`
  const scenesRes = await fetcher.fetch(scenesUrl)
  if (!scenesRes.ok) {
    throw new Error(`Failed to fetch world scenes: ${scenesRes.status} ${scenesRes.statusText}`)
  }
  const scenesBody = await scenesRes.json()
  const scenes = (scenesBody as any).scenes as any[]
  if (!scenes?.length) {
    throw new Error(`World "${worldName}" has no scenes`)
  }
  const scene = scenes.find((s: any) => s.parcels?.includes(coords))
  if (!scene) {
    const available = scenes.map((s: any) => s.parcels?.join(', ')).join(' | ')
    throw new Error(`Coords "${coords}" not found in world "${worldName}". Available parcels: ${available}`)
  }
  return scene.entityId
}

async function resolveEntityId(
  fetcher: IFetchComponent,
  worldName: string | undefined,
  coords: string,
  baseUrl: string
): Promise<string> {
  if (worldName) {
    return resolveWorldEntity(fetcher, worldName, coords, baseUrl)
  }
  const entities = await getEntities(fetcher, [coords], baseUrl)
  if (!entities.length) {
    throw new Error(`Could not resolve coords "${coords}" at ${baseUrl}`)
  }
  return entities[0].id
}

function readManifest(cdnS3: any, entityId: string, buildTarget: string): Promise<Manifest> {
  const manifestKey = buildTarget !== 'webgl' ? `manifest/${entityId}_${buildTarget}.json` : `manifest/${entityId}.json`
  return cdnS3
    .getObject({ Bucket: BUCKET_NAME, Key: manifestKey })
    .promise()
    .then((res: any) => JSON.parse(res.Body!.toString()))
    .catch((err: any) => {
      throw new Error(`Manifest not found at ${manifestKey}: ${err.message}`)
    })
}

function verifyBundles(
  manifest: Manifest,
  entityId: string,
  abVersion: string,
  logger: any
): { failures: number; bundleFiles: Set<string> } {
  const canonicalPrefix = `${abVersion}/assets`
  const entityScopedPrefix = `${abVersion}/${entityId}`
  let failures = 0
  const bundleFiles = new Set<string>()

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
    bundleFiles.add(bundleFilename)
  }

  return { failures, bundleFiles }
}

/** Recursively snapshot all files under a directory with their mtimes. */
function snapshotFiles(dir: string): Map<string, number> {
  const result = new Map<string, number>()
  if (!fs.existsSync(dir)) return result
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      for (const [k, v] of snapshotFiles(full)) result.set(k, v)
    } else {
      result.set(full, fs.statSync(full).mtimeMs)
    }
  }
  return result
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  ensureUlf()

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
  const components = { logs, metrics, config, cdnS3, sentry }

  const fetcher = await createFetchComponent()
  const abVersion = await config.requireString(abVersionEnvName)

  // ---- Conversion 1 ----
  const entityId1 = await resolveEntityId(fetcher, WORLD_NAME, COORDS, BASE_URL)
  logger.info(`Scene 1: entityId=${entityId1}`)

  const exitCode1 = await executeConversion(components, entityId1, BASE_URL, false, 'legacy', false, abVersion)
  logger.info(`Scene 1 conversion finished with exitCode=${exitCode1}`)
  if (exitCode1 !== 0 && exitCode1 !== 2) {
    throw new Error(`Scene 1 conversion failed with exitCode=${exitCode1}`)
  }

  const manifest1 = await readManifest(cdnS3, entityId1, $BUILD_TARGET)
  logger.info(`Scene 1 manifest: ${manifest1.files.length} bundle(s)`)
  if (!manifest1.files.length) {
    throw new Error('Scene 1 manifest has zero files')
  }

  const result1 = verifyBundles(manifest1, entityId1, abVersion, logger)
  if (result1.failures > 0) {
    throw new Error(`Scene 1: ${result1.failures} bundle(s) missing or empty out of ${manifest1.files.length}`)
  }
  logger.info(`Scene 1: all ${manifest1.files.length} bundle(s) verified`)

  // ---- Conversion 2 (optional) ----
  if (!WORLD_NAME_2 && !COORDS_2) {
    logger.info('No second scene specified — done')
    return
  }

  if (!COORDS_2) {
    throw new Error('--coords2 is required when --world2 is specified')
  }

  const baseUrl2 =
    args['--baseUrl'] ||
    (WORLD_NAME_2 ? 'https://worlds-content-server.decentraland.zone' : 'https://peer.decentraland.zone/content')

  // Snapshot all files + mtimes in mock S3 before Scene 2 runs. After Scene 2,
  // a bundle is truly reused only if the file existed AND its mtime is unchanged
  // (not overwritten by a re-upload).
  const snapshotBeforeScene2 = snapshotFiles(path.join(MOCK_S3_BASE, BUCKET_NAME))

  const entityId2 = await resolveEntityId(fetcher, WORLD_NAME_2, COORDS_2, baseUrl2)
  logger.info(`Scene 2: entityId=${entityId2}`)

  const exitCode2 = await executeConversion(components, entityId2, baseUrl2, false, 'legacy', false, abVersion)
  logger.info(`Scene 2 conversion finished with exitCode=${exitCode2}`)
  if (exitCode2 !== 0 && exitCode2 !== 2) {
    throw new Error(`Scene 2 conversion failed with exitCode=${exitCode2}`)
  }

  const manifest2 = await readManifest(cdnS3, entityId2, $BUILD_TARGET)
  logger.info(`Scene 2 manifest: ${manifest2.files.length} bundle(s)`)
  if (!manifest2.files.length) {
    throw new Error('Scene 2 manifest has zero files')
  }

  const result2 = verifyBundles(manifest2, entityId2, abVersion, logger)
  if (result2.failures > 0) {
    throw new Error(`Scene 2: ${result2.failures} bundle(s) missing or empty out of ${manifest2.files.length}`)
  }
  logger.info(`Scene 2: all ${manifest2.files.length} bundle(s) verified`)

  // ---- Cross-scene deduplication checks ----
  // For each bundle in Scene 2's manifest, check whether the file on disk
  // already existed before Scene 2 ran (= reused) or is new (= freshly converted).
  const canonicalPrefix = `${abVersion}/assets`
  const entityScopedPrefix2 = `${abVersion}/${entityId2}`
  const reused: string[] = []
  const freshlyConverted: string[] = []

  for (const bundleFilename of manifest2.files) {
    const canonicalPath = path.join(MOCK_S3_BASE, BUCKET_NAME, canonicalPrefix, bundleFilename)
    const entityScopedPath = path.join(MOCK_S3_BASE, BUCKET_NAME, entityScopedPrefix2, bundleFilename)

    const filePath = fs.existsSync(canonicalPath) ? canonicalPath : fs.existsSync(entityScopedPath) ? entityScopedPath : null

    const previousMtime = filePath ? snapshotBeforeScene2.get(filePath) : undefined
    const currentMtime = filePath ? fs.statSync(filePath).mtimeMs : undefined

    if (previousMtime !== undefined && previousMtime === currentMtime) {
      reused.push(bundleFilename)
    } else {
      freshlyConverted.push(bundleFilename)
    }
  }

  logger.info(`Scene 2 reused ${reused.length} bundle(s) from Scene 1:`)
  reused.forEach((f) => logger.info(`  REUSED: ${f}`))

  logger.info(`Scene 2 freshly converted ${freshlyConverted.length} bundle(s):`)
  freshlyConverted.forEach((f) => logger.info(`  NEW: ${f}`))

  if (reused.length === 0) {
    throw new Error('Expected at least one reused bundle in Scene 2, found none — deduplication not working')
  }

  if (freshlyConverted.length === 0) {
    throw new Error('Expected at least one freshly converted bundle in Scene 2 (albedo.png differs), but all were reused')
  }

  logger.info(
    `Cross-scene deduplication verified: ${reused.length} reused, ${freshlyConverted.length} freshly converted`
  )
}

main()
  .then(() => {
    process.exit(0)
  })
  .catch((err) => {
    console.error('E2E FAILED:', err)
    process.exit(1)
  })
