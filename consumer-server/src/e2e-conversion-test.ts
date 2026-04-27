// End-to-end conversion + deduplication test.
//
// Converts three scenes sequentially against the same mock-aws-s3 store:
//   1. ABTestScene1.dcl.eth (worlds) — everything fresh
//   2. ABTestScene2.dcl.eth (worlds) — shared assets should be reused from #1
//   3. Catalyst scene at 19,3 (peer.decentraland.zone) — same scene as #2, cross-server dedup
//
// After each conversion, verifies all manifest bundles exist and are non-empty.
// After conversions #2 and #3, validates deduplication via mtime comparison:
//   - Reused bundles: file existed before and mtime unchanged
//   - Fresh bundles: new file or mtime changed

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

// All three scenes share Cube.gltf (same hash), Cube.bin, Store_02.glb,
// FloorBaseGrass_02.glb, file1.png, and Floor_Grass02.png.png.
//
// Scene 1 vs Scene 2:
//   - albedo.png has a different hash. Scene 2 has GeckoStone_01.glb which
//     Scene 1 doesn't. The texture/buffer sets differ, so the depsDigest
//     differs — all shared GLB/GLTF bundles (Cube, Store_02, FloorBaseGrass_02)
//     get different composite canonical filenames and must be reconverted.
//   - Leaf assets with the same hash (Cube.bin, file1.png, Floor_Grass02.png.png)
//     should be reused from Scene 1.
//
// Scene 2 vs Catalyst 19,3:
//   - Same scene deployed to a different server (worlds vs catalyst).
//     All bundleable assets (textures, buffers, GLBs) have identical hashes,
//     so the depsDigest is the same. scene.json differs (different parcel
//     coords) but it's not a texture/buffer so it doesn't affect the digest.
//   - All bundles should be fully reused — zero fresh conversions.
const SCENES = [
  { name: 'ABTestScene1.dcl.eth', coords: '0,0', baseUrl: WORLDS_BASE_URL, isWorld: true, expectFresh: true },
  { name: 'ABTestScene2.dcl.eth', coords: '0,0', baseUrl: WORLDS_BASE_URL, isWorld: true, expectFresh: true },
  { name: 'Catalyst 19,3', coords: '19,3', baseUrl: CATALYST_BASE_URL, isWorld: false, expectFresh: false }
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

async function resolveEntityId(fetcher: IFetchComponent, sceneDef: (typeof SCENES)[number]): Promise<string> {
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
      logger.error(`MISSING bundle (checked ${canonicalPrefix}/ and ${entityScopedPrefix}/)`)
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

function checkDedup(
  manifest: Manifest,
  entityId: string,
  abVersion: string,
  snapshotBefore: Map<string, number>
): { reused: string[]; fresh: string[] } {
  const canonicalPrefix = `${abVersion}/assets`
  const entityScopedPrefix = `${abVersion}/${entityId}`
  const reused: string[] = []
  const fresh: string[] = []

  for (const bundleFilename of manifest.files) {
    const canonicalPath = path.join(MOCK_S3_BASE, BUCKET_NAME, canonicalPrefix, bundleFilename)
    const entityScopedPath = path.join(MOCK_S3_BASE, BUCKET_NAME, entityScopedPrefix, bundleFilename)

    const filePath = fs.existsSync(canonicalPath)
      ? canonicalPath
      : fs.existsSync(entityScopedPath)
        ? entityScopedPath
        : null

    const previousMtime = filePath ? snapshotBefore.get(filePath) : undefined
    const currentMtime = filePath ? fs.statSync(filePath).mtimeMs : undefined

    if (previousMtime !== undefined && previousMtime === currentMtime) {
      reused.push(bundleFilename)
    } else {
      fresh.push(bundleFilename)
    }
  }

  return { reused, fresh }
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

  for (let i = 0; i < SCENES.length; i++) {
    const sceneDef = SCENES[i]
    const sceneLabel = `Scene ${i + 1} (${sceneDef.name})`

    logger.info(`\n========== ${sceneLabel} ==========`)

    const entityId = await resolveEntityId(fetcher, sceneDef)
    logger.info(`${sceneLabel}: entityId=${entityId}`)

    // Snapshot before conversion so we can detect reuse
    const snapshotBefore = snapshotFiles(path.join(MOCK_S3_BASE, BUCKET_NAME))

    const tStart = Date.now()
    const exitCode = await executeConversion(components, entityId, sceneDef.baseUrl, false, 'legacy', false, abVersion)
    const elapsed = ((Date.now() - tStart) / 1000).toFixed(1)

    logger.info(`${sceneLabel}: exitCode=${exitCode}, elapsed=${elapsed}s`)
    if (exitCode !== 0 && exitCode !== 2) {
      throw new Error(`${sceneLabel} conversion failed with exitCode=${exitCode}`)
    }

    // Verify all bundles exist
    const manifest = await readManifest(cdnS3, entityId, $BUILD_TARGET)
    logger.info(`${sceneLabel}: manifest has ${manifest.files.length} bundle(s)`)
    if (!manifest.files.length) {
      throw new Error(`${sceneLabel} manifest has zero files`)
    }

    const failures = verifyBundles(manifest, entityId, abVersion, logger)
    if (failures > 0) {
      throw new Error(`${sceneLabel}: ${failures} bundle(s) missing or empty out of ${manifest.files.length}`)
    }

    // Dedup check (skip for first scene — nothing to compare against)
    if (i > 0) {
      const { reused, fresh } = checkDedup(manifest, entityId, abVersion, snapshotBefore)

      logger.info(`${sceneLabel} reused ${reused.length} bundle(s):`)
      reused.forEach((f) => logger.info(`  REUSED: ${f}`))

      logger.info(`${sceneLabel} freshly converted ${fresh.length} bundle(s):`)
      fresh.forEach((f) => logger.info(`  NEW: ${f}`))

      if (reused.length === 0) {
        throw new Error(`${sceneLabel}: expected reused bundles, found none — deduplication not working`)
      }

      if (sceneDef.expectFresh && fresh.length === 0) {
        throw new Error(`${sceneLabel}: expected fresh bundles (scenes differ), but all were reused`)
      }

      if (!sceneDef.expectFresh && fresh.length > 0) {
        throw new Error(
          `${sceneLabel}: expected all bundles reused (identical scene), but ${fresh.length} were freshly converted`
        )
      }

      logger.info(`${sceneLabel}: dedup verified — ${reused.length} reused, ${fresh.length} fresh, ${elapsed}s`)
    } else {
      logger.info(`${sceneLabel}: all ${manifest.files.length} bundle(s) verified, ${elapsed}s`)
    }
  }

  // ---- Write bundle paths JSON for Unity test ----
  // The Unity test needs to know where to find the Cube and albedo bundles
  // for Scene 1 and Scene 2 so it can load them and verify mesh/texture.
  const CUBE_GLTF_HASH = 'bafkreie5su6wnqzj7ppqzlbd4m2sgf3q76hkpzsfiqun5rfd54xvokepcm'
  const ALBEDO_HASH_S1 = 'bafkreigy4f55gqd5g6citumtzcefwdwdtqh5nfnwia7dnwawigqem4wlhq'
  const ALBEDO_HASH_S2 = 'bafybeich3nzq4bym2mufrymp3bg5yy7vdts2mgixfsutv5kzt5gm2j4m7m'

  const s3Root = path.join(MOCK_S3_BASE, BUCKET_NAME)
  const assetsDir = path.join(s3Root, abVersion, 'assets')

  function findBundle(dir: string, hashPrefix: string): string | null {
    if (!fs.existsSync(dir)) return null
    const entries = fs.readdirSync(dir)
    // Match the bundle file (not .manifest, not .br, not metadata subdir)
    const match = entries.find(
      (e) => e.startsWith(hashPrefix) && !e.includes('.') && fs.statSync(path.join(dir, e)).isFile()
    )
    return match ? path.join(dir, match) : null
  }

  // Scene 1 manifest was stored earlier — find Cube and albedo bundles
  const scene1CubePath = findBundle(assetsDir, CUBE_GLTF_HASH)
  const scene1AlbedoPath = findBundle(assetsDir, ALBEDO_HASH_S1)

  // Scene 2 — Cube has a different depsDigest so it's a different file
  // Find the Cube bundle that is NOT Scene 1's
  const allCubeBundles = fs.existsSync(assetsDir)
    ? fs.readdirSync(assetsDir).filter(
        (e) => e.startsWith(CUBE_GLTF_HASH) && !e.includes('.') && fs.statSync(path.join(assetsDir, e)).isFile()
      )
    : []
  const scene2CubeFile = allCubeBundles.find((f) => path.join(assetsDir, f) !== scene1CubePath)
  const scene2CubePath = scene2CubeFile ? path.join(assetsDir, scene2CubeFile) : null
  const scene2AlbedoPath = findBundle(assetsDir, ALBEDO_HASH_S2)

  const bundlePaths = {
    scene1CubePath,
    scene1AlbedoPath,
    scene2CubePath,
    scene2AlbedoPath
  }

  const bundlePathsFile = '/tmp/e2e-bundle-paths.json'
  fs.writeFileSync(bundlePathsFile, JSON.stringify(bundlePaths, null, 2))
  logger.info(`Bundle paths written to ${bundlePathsFile}`)
  logger.info(JSON.stringify(bundlePaths, null, 2))

  if (!scene1CubePath || !scene1AlbedoPath || !scene2CubePath || !scene2AlbedoPath) {
    logger.warn('Some bundle paths could not be resolved — Unity test may fail')
  }

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
