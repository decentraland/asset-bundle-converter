// E2E conversion + deduplication test.
// See test/e2e/README.md for scene descriptions and expected behavior.
//
// Requires Unity — runs inside the Docker image, not during `yarn test`.
// Invoked via: npx jest --config jest.e2e.config.js

import * as fs from 'fs'
import * as path from 'path'
import MockAws from 'mock-aws-s3'
import { createConfigComponent } from '@well-known-components/env-config-provider'
import { createLogComponent } from '@well-known-components/logger'
import { createMetricsComponent } from '@well-known-components/metrics'
import { metricDeclarations } from '../../src/metrics'
import { getEntities } from '../../src/logic/fetch-entity-by-pointer'
import { createFetchComponent } from '../../src/adapters/fetch'
import { executeConversion } from '../../src/logic/conversion-task'
import { getAbVersionEnvName } from '../../src/utils'
import { ensureUlf } from '../../src/logic/ensure-ulf'
import { IFetchComponent } from '@well-known-components/interfaces'

// ---------------------------------------------------------------------------
// Test scenes
// ---------------------------------------------------------------------------

const WORLDS_BASE_URL = 'https://worlds-content-server.decentraland.zone'
const CATALYST_BASE_URL = 'https://peer.decentraland.zone/content'
const CUBE_GLTF_HASH = 'bafkreie5su6wnqzj7ppqzlbd4m2sgf3q76hkpzsfiqun5rfd54xvokepcm'

type SceneDef = {
  name: string
  coords: string
  baseUrl: string
  isWorld: boolean
  expectedNewFiles: number // -1 = don't check exact count
  expectMissingHash: string | null
}

const SCENES: SceneDef[] = [
  { name: 'ABTestScene1.dcl.eth', coords: '0,0', baseUrl: WORLDS_BASE_URL, isWorld: true, expectedNewFiles: -1, expectMissingHash: null },
  { name: 'ABTestScene2.dcl.eth', coords: '0,0', baseUrl: WORLDS_BASE_URL, isWorld: true, expectedNewFiles: 12, expectMissingHash: null },
  { name: 'Catalyst 19,3', coords: '19,3', baseUrl: CATALYST_BASE_URL, isWorld: false, expectedNewFiles: 0, expectMissingHash: null },
  { name: 'ABTestScene3.dcl.eth', coords: '0,0', baseUrl: WORLDS_BASE_URL, isWorld: true, expectedNewFiles: -1, expectMissingHash: CUBE_GLTF_HASH }
]

// ---------------------------------------------------------------------------
// Env
// ---------------------------------------------------------------------------

const $UNITY_PATH = process.env.UNITY_PATH
const $PROJECT_PATH = process.env.PROJECT_PATH
const $BUILD_TARGET = process.env.BUILD_TARGET || 'webgl'

const MOCK_S3_BASE = '/tmp/e2e-mock-s3'
const BUCKET_NAME = 'e2e-test-bucket'

type Manifest = { version: string; files: string[]; exitCode: number | null }

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type WorldScene = { parcels: string[]; entityId: string }
type WorldScenesResponse = { scenes: WorldScene[] }

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

function countFiles(dir: string): number {
  if (!fs.existsSync(dir)) return 0
  return fs.readdirSync(dir).filter((e) => fs.statSync(path.join(dir, e)).isFile()).length
}

function snapshotMtimes(dir: string): Map<string, number> {
  const result = new Map<string, number>()
  if (!fs.existsSync(dir)) return result
  for (const entry of fs.readdirSync(dir)) {
    const full = path.join(dir, entry)
    if (fs.statSync(full).isFile()) {
      result.set(entry, fs.statSync(full).mtimeMs)
    }
  }
  return result
}

function findOverwrites(before: Map<string, number>, dir: string): string[] {
  const overwrites: string[] = []
  for (const [name, mtimeBefore] of before) {
    const full = path.join(dir, name)
    if (fs.existsSync(full) && fs.statSync(full).mtimeMs !== mtimeBefore) {
      overwrites.push(name)
    }
  }
  return overwrites
}

function verifyAllBundlesExist(manifest: Manifest, entityId: string, abVersion: string): string[] {
  const canonicalPrefix = `${abVersion}/assets`
  const entityScopedPrefix = `${abVersion}/${entityId}`
  const missing: string[] = []

  for (const bundleFilename of manifest.files) {
    const canonicalPath = path.join(MOCK_S3_BASE, BUCKET_NAME, canonicalPrefix, bundleFilename)
    const entityScopedPath = path.join(MOCK_S3_BASE, BUCKET_NAME, entityScopedPrefix, bundleFilename)

    const foundPath = fs.existsSync(canonicalPath)
      ? canonicalPath
      : fs.existsSync(entityScopedPath)
        ? entityScopedPath
        : null

    if (!foundPath || fs.statSync(foundPath).size === 0) {
      missing.push(bundleFilename)
    }
  }

  return missing
}

// ---------------------------------------------------------------------------
// Test
// ---------------------------------------------------------------------------

describe('when converting scenes end-to-end with real Unity', () => {
  let components: any
  let fetcher: IFetchComponent
  let abVersion: string
  let assetsDir: string

  beforeAll(async () => {
    if (!$UNITY_PATH) throw new Error('UNITY_PATH env var is not defined')
    if (!$PROJECT_PATH) throw new Error('PROJECT_PATH env var is not defined')

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
    const sentry = { captureMessage: () => {}, captureException: () => {} } as any
    components = { logs, metrics, config, cdnS3, sentry }

    fetcher = await createFetchComponent()
    abVersion = await config.requireString(abVersionEnvName)
    assetsDir = path.join(MOCK_S3_BASE, BUCKET_NAME, abVersion, 'assets')
  })

  // Scenes run sequentially sharing the same mock S3 store.
  // Each `it` block converts one scene and verifies the results.
  // Order matters — later scenes depend on bundles from earlier ones.

  for (let i = 0; i < SCENES.length; i++) {
    const sceneDef = SCENES[i]
    const sceneLabel = `Scene ${i + 1} (${sceneDef.name})`

    describe(`and converting ${sceneLabel}`, () => {
      let entityId: string
      let manifest: Manifest
      let filesBefore: number
      let mtimesBefore: Map<string, number>
      let exitCode: number | undefined

      beforeAll(async () => {
        entityId = await resolveEntityId(fetcher, sceneDef)
        filesBefore = countFiles(assetsDir)
        mtimesBefore = snapshotMtimes(assetsDir)

        exitCode = await executeConversion(
          components,
          entityId,
          sceneDef.baseUrl,
          false,
          'legacy',
          false,
          abVersion
        )

        manifest = await readManifest(components.cdnS3, entityId, $BUILD_TARGET)
      })

      it('should finish with an acceptable exit code', () => {
        // 0 = SUCCESS, 12 = CONVERSION_ERRORS_TOLERATED
        expect([0, 12]).toContain(exitCode)
      })

      it('should produce a manifest with bundles', () => {
        expect(manifest.files.length).toBeGreaterThan(0)
      })

      it('should have all manifest bundles present and non-empty on disk', () => {
        const missing = verifyAllBundlesExist(manifest, entityId, abVersion)
        expect(missing).toEqual([])
      })

      if (sceneDef.expectedNewFiles >= 0) {
        it(`should have exactly ${sceneDef.expectedNewFiles} new file(s) in assets/`, () => {
          const filesAfter = countFiles(assetsDir)
          const newFiles = filesAfter - filesBefore
          expect(newFiles).toBe(sceneDef.expectedNewFiles)
        })
      }

      if (sceneDef.expectedNewFiles === 0) {
        it('should not overwrite any existing files (full reuse)', () => {
          const overwrites = findOverwrites(mtimesBefore, assetsDir)
          expect(overwrites).toEqual([])
        })
      }

      if (sceneDef.expectMissingHash) {
        it(`should not include hash ${sceneDef.expectMissingHash.slice(0, 16)}... in manifest (broken reference)`, () => {
          const found = manifest.files.some((f: string) => f.startsWith(sceneDef.expectMissingHash!))
          expect(found).toBe(false)
        })
      }
    })
  }
})
