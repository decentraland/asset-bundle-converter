// E2E conversion + deduplication test.
// See e2e-conversion-test.README.md for scene descriptions and expected behavior.

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

// ---------------------------------------------------------------------------
// Hardcoded test scenes
// ---------------------------------------------------------------------------

const WORLDS_BASE_URL = 'https://worlds-content-server.decentraland.zone'
const CATALYST_BASE_URL = 'https://peer.decentraland.zone/content'

const CUBE_GLTF_HASH = 'bafkreie5su6wnqzj7ppqzlbd4m2sgf3q76hkpzsfiqun5rfd54xvokepcm'
const ALBEDO_HASH_S1 = 'bafkreigy4f55gqd5g6citumtzcefwdwdtqh5nfnwia7dnwawigqem4wlhq'
const ALBEDO_HASH_S2 = 'bafybeich3nzq4bym2mufrymp3bg5yy7vdts2mgixfsutv5kzt5gm2j4m7m'

type SceneDef = {
  name: string
  coords: string
  baseUrl: string
  isWorld: boolean
  expectedNewFiles: number // -1 = don't check exact count
  expectMissingHash: string | null
}

const SCENES: SceneDef[] = [
  {
    name: 'ABTestScene1.dcl.eth',
    coords: '0,0',
    baseUrl: WORLDS_BASE_URL,
    isWorld: true,
    expectedNewFiles: -1,
    expectMissingHash: null
  },
  {
    name: 'ABTestScene2.dcl.eth',
    coords: '0,0',
    baseUrl: WORLDS_BASE_URL,
    isWorld: true,
    expectedNewFiles: 12,
    expectMissingHash: null
  },
  {
    name: 'Catalyst 19,3',
    coords: '19,3',
    baseUrl: CATALYST_BASE_URL,
    isWorld: false,
    expectedNewFiles: 0,
    expectMissingHash: null
  },
  {
    name: 'ABTestScene3.dcl.eth',
    coords: '0,0',
    baseUrl: WORLDS_BASE_URL,
    isWorld: true,
    expectedNewFiles: -1,
    expectMissingHash: CUBE_GLTF_HASH
  }
]

// ---------------------------------------------------------------------------
// Env
// ---------------------------------------------------------------------------

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
  type WorldScene = { parcels: string[]; entityId: string }
  type WorldScenesResponse = { scenes: WorldScene[] }
  const scenesBody = (await scenesRes.json()) as WorldScenesResponse
  if (!scenesBody.scenes?.length) {
    throw new Error(`World "${worldName}" has no scenes`)
  }
  const scene = scenesBody.scenes.find((s) => s.parcels?.includes(coords))
  if (!scene) {
    const available = scenesBody.scenes.map((s) => s.parcels?.join(', ')).join(' | ')
    throw new Error(`Coords "${coords}" not found in world "${worldName}". Available parcels: ${available}`)
  }
  return scene.entityId
}

async function resolveEntityId(fetcher: IFetchComponent, sceneDef: SceneDef): Promise<string> {
  if (sceneDef.isWorld) {
    return resolveWorldEntity(fetcher, sceneDef.name, sceneDef.coords, sceneDef.baseUrl)
  }
  const entities = await getEntities(fetcher, [sceneDef.coords], sceneDef.baseUrl)
  if (!entities.length) {
    throw new Error(`Could not resolve coords "${sceneDef.coords}" at ${sceneDef.baseUrl}`)
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

function verifyBundles(manifest: Manifest, entityId: string, abVersion: string, logger: any): number {
  const canonicalPrefix = `${abVersion}/assets`
  const entityScopedPrefix = `${abVersion}/${entityId}`
  let failures = 0

  for (const bundleFilename of manifest.files) {
    const canonicalPath = path.join(MOCK_S3_BASE, BUCKET_NAME, canonicalPrefix, bundleFilename)
    const entityScopedPath = path.join(MOCK_S3_BASE, BUCKET_NAME, entityScopedPrefix, bundleFilename)

    const foundPath = fs.existsSync(canonicalPath)
      ? canonicalPath
      : fs.existsSync(entityScopedPath)
        ? entityScopedPath
        : null

    if (!foundPath) {
      logger.error(`MISSING bundle ${bundleFilename} (checked ${canonicalPrefix}/ and ${entityScopedPrefix}/)`)
      failures++
      continue
    }

    const stat = fs.statSync(foundPath)
    if (stat.size === 0) {
      logger.error(`EMPTY bundle (0 bytes): ${foundPath}`)
      failures++
      continue
    }

    const usedKey =
      foundPath === canonicalPath ? `${canonicalPrefix}/${bundleFilename}` : `${entityScopedPrefix}/${bundleFilename}`
    logger.info(`OK: ${usedKey} (${stat.size} bytes)`)
  }

  return failures
}

/** Count files directly in a directory (not recursive, not subdirs). */
function countFiles(dir: string): number {
  if (!fs.existsSync(dir)) return 0
  return fs.readdirSync(dir).filter((e) => fs.statSync(path.join(dir, e)).isFile()).length
}

/** Find a bundle file by hash prefix in the assets dir. */
function findBundle(dir: string, hashPrefix: string): string | null {
  if (!fs.existsSync(dir)) return null
  const match = fs
    .readdirSync(dir)
    .find((e) => e.startsWith(hashPrefix) && !e.includes('.') && fs.statSync(path.join(dir, e)).isFile())
  return match ? path.join(dir, match) : null
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
  const assetsDir = path.join(MOCK_S3_BASE, BUCKET_NAME, abVersion, 'assets')

  type SceneResult = {
    label: string
    entityId: string
    exitCode: number
    elapsed: string
    bundleCount: number
    filesBefore: number
    filesAfter: number
    newFiles: number
    missingHashAbsent?: boolean
  }
  const results: SceneResult[] = []

  for (let i = 0; i < SCENES.length; i++) {
    const sceneDef = SCENES[i]
    const sceneLabel = `Scene ${i + 1} (${sceneDef.name})`

    logger.info(`\n========== ${sceneLabel} ==========`)

    const entityId = await resolveEntityId(fetcher, sceneDef)
    logger.info(`${sceneLabel}: entityId=${entityId}`)

    const filesBefore = countFiles(assetsDir)

    const tStart = Date.now()
    const exitCode = await executeConversion(components, entityId, sceneDef.baseUrl, false, 'legacy', false, abVersion)
    const elapsed = ((Date.now() - tStart) / 1000).toFixed(1)

    // Unity ErrorCodes enum: 0 = SUCCESS, 12 = CONVERSION_ERRORS_TOLERATED
    const acceptableExitCodes = [0, 12]
    logger.info(`${sceneLabel}: exitCode=${exitCode}, elapsed=${elapsed}s`)
    if (!acceptableExitCodes.includes(exitCode ?? -1)) {
      throw new Error(`${sceneLabel} conversion failed with exitCode=${exitCode}`)
    }

    // Verify all bundles exist
    const manifest = await readManifest(cdnS3, entityId, $BUILD_TARGET)
    logger.info(`${sceneLabel}: manifest has ${manifest.files.length} bundle(s)`)

    // Check that a specific hash is NOT in the manifest (broken reference test)
    if (sceneDef.expectMissingHash) {
      const found = manifest.files.some((f: string) => f.startsWith(sceneDef.expectMissingHash!))
      if (found) {
        throw new Error(
          `${sceneLabel}: expected hash ${sceneDef.expectMissingHash} to be ABSENT from manifest (broken reference), but it was found`
        )
      }
      logger.info(`${sceneLabel}: confirmed hash ${sceneDef.expectMissingHash} is absent from manifest`)
    }

    const failures = verifyBundles(manifest, entityId, abVersion, logger)
    if (failures > 0) {
      throw new Error(`${sceneLabel}: ${failures} bundle(s) missing or empty out of ${manifest.files.length}`)
    }

    // Count new files in assets/ dir
    const filesAfter = countFiles(assetsDir)
    const newFiles = filesAfter - filesBefore
    logger.info(`${sceneLabel}: assets/ had ${filesBefore} files before, ${filesAfter} after (${newFiles} new)`)

    if (sceneDef.expectedNewFiles >= 0 && newFiles !== sceneDef.expectedNewFiles) {
      throw new Error(`${sceneLabel}: expected ${sceneDef.expectedNewFiles} new file(s) in assets/, got ${newFiles}`)
    }

    results.push({
      label: sceneLabel,
      entityId,
      exitCode: exitCode ?? -1,
      elapsed,
      bundleCount: manifest.files.length,
      filesBefore,
      filesAfter,
      newFiles,
      missingHashAbsent: sceneDef.expectMissingHash ? true : undefined
    })
  }

  // ---- Final report ----
  logger.info('\n========== E2E TEST REPORT ==========')
  for (const r of results) {
    logger.info(`\n${r.label}`)
    logger.info(`  Entity:       ${r.entityId}`)
    logger.info(`  Exit:         ${r.exitCode}`)
    logger.info(`  Time:         ${r.elapsed}s`)
    logger.info(`  Bundles:      ${r.bundleCount}`)
    logger.info(`  Files before: ${r.filesBefore}`)
    logger.info(`  Files after:  ${r.filesAfter}`)
    logger.info(`  New files:    ${r.newFiles}`)
    if (r.missingHashAbsent) {
      logger.info(`  Broken ref:   Cube hash correctly absent from manifest`)
    }
  }
  logger.info('\n=====================================')

  // ---- Write bundle paths JSON for Unity test ----
  const scene1CubePath = findBundle(assetsDir, CUBE_GLTF_HASH)
  const scene1AlbedoPath = findBundle(assetsDir, ALBEDO_HASH_S1)

  if (!scene1CubePath) throw new Error('scene1CubePath is null — Cube bundle not found after Scene 1')

  // Scene 2's Cube has a different depsDigest — find the one that isn't Scene 1's
  const allCubeBundles = fs.existsSync(assetsDir)
    ? fs
        .readdirSync(assetsDir)
        .filter(
          (e) => e.startsWith(CUBE_GLTF_HASH) && !e.includes('.') && fs.statSync(path.join(assetsDir, e)).isFile()
        )
    : []
  if (allCubeBundles.length !== 2) {
    throw new Error(
      `Expected 2 Cube bundles (one per depsDigest), found ${allCubeBundles.length}: [${allCubeBundles.join(', ')}]`
    )
  }
  const scene2CubeFile = allCubeBundles.find((f) => path.join(assetsDir, f) !== scene1CubePath)!
  const scene2CubePath = path.join(assetsDir, scene2CubeFile)
  const scene2AlbedoPath = findBundle(assetsDir, ALBEDO_HASH_S2)

  if (!scene1AlbedoPath || !scene2AlbedoPath) {
    throw new Error(`Missing albedo bundle: scene1=${scene1AlbedoPath}, scene2=${scene2AlbedoPath}`)
  }

  const bundlePaths = { scene1CubePath, scene1AlbedoPath, scene2CubePath, scene2AlbedoPath }
  const bundlePathsFile = '/tmp/e2e-bundle-paths.json'
  fs.writeFileSync(bundlePathsFile, JSON.stringify(bundlePaths, null, 2))
  logger.info(`\nBundle paths for Unity test: ${bundlePathsFile}`)
  logger.info(JSON.stringify(bundlePaths, null, 2))

  logger.info('\n========== ALL SCENES PASSED ==========')
}

main()
  .then(() => {
    process.exit(0)
  })
  .catch((err) => {
    console.error('E2E FAILED:', err)
    process.exit(1)
  })
