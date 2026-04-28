// E2E conversion + deduplication test.
// See test/e2e/README.md for scene descriptions and expected behavior.
//
// Requires Unity — runs inside the Docker image, not during `yarn test`.
// Invoked via: npx jest --config jest.e2e.config.js
//
// Starts the full consumer-server (HTTP + in-memory queue), POSTs jobs to
// /queue-task via localFetch, and polls mock S3 for manifests.

import * as fs from 'fs'
import * as path from 'path'
import MockAws from 'mock-aws-s3'
import { test } from '../components'
import { ensureUlf } from '../../src/logic/ensure-ulf'
import { getAbVersionEnvName } from '../../src/utils'
import { AuthLinkType } from '@dcl/schemas/dist/misc/auth-chain'

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

const $BUILD_TARGET = process.env.BUILD_TARGET || 'webgl'
process.env.PLATFORM = $BUILD_TARGET
process.env.ASSET_REUSE_ENABLED = 'true'
// AWS_SNS_ARN is required by the publisher component at init time
process.env.AWS_SNS_ARN = process.env.AWS_SNS_ARN || 'arn:aws:sns:us-east-1:000000000000:e2e-test'

const MOCK_S3_BASE = '/tmp/e2e-mock-s3'
const BUCKET_NAME = 'CDN_BUCKET' // default when CDN_BUCKET env is unset

type Manifest = { version: string; files: string[]; exitCode: number | null }

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type WorldScene = { parcels: string[]; entityId: string }
type WorldScenesResponse = { scenes: WorldScene[] }

async function resolveWorldEntity(worldName: string, coords: string, baseUrl: string): Promise<string> {
  const res = await fetch(`${baseUrl}/world/${worldName}/scenes`)
  if (!res.ok) throw new Error(`Failed to fetch world scenes: ${res.status}`)
  const body = (await res.json()) as WorldScenesResponse
  if (!body.scenes?.length) throw new Error(`World "${worldName}" has no scenes`)
  const scene = body.scenes.find((s) => s.parcels?.includes(coords))
  if (!scene) {
    const available = body.scenes.map((s) => s.parcels?.join(', ')).join(' | ')
    throw new Error(`Coords "${coords}" not found in world "${worldName}". Available: ${available}`)
  }
  return scene.entityId
}

async function resolveEntityId(sceneDef: SceneDef): Promise<string> {
  if (sceneDef.isWorld) {
    return resolveWorldEntity(sceneDef.name, sceneDef.coords, sceneDef.baseUrl)
  }
  const res = await fetch(`${sceneDef.baseUrl}/entities/active`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ pointers: [sceneDef.coords] })
  })
  if (!res.ok) throw new Error(`Failed to resolve ${sceneDef.coords}: ${res.status}`)
  const entities = (await res.json()) as { id: string }[]
  if (!entities.length) throw new Error(`No entity at ${sceneDef.coords}`)
  return entities[0].id
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

function readManifestFromDisk(buildTarget: string, entityId: string): Manifest | null {
  const manifestKey =
    buildTarget !== 'webgl' ? `manifest/${entityId}_${buildTarget}.json` : `manifest/${entityId}.json`
  const filePath = path.join(MOCK_S3_BASE, BUCKET_NAME, manifestKey)
  if (!fs.existsSync(filePath)) return null
  return JSON.parse(fs.readFileSync(filePath, 'utf-8'))
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

async function waitForManifest(buildTarget: string, entityId: string, timeoutMs: number = 600000): Promise<Manifest> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const manifest = readManifestFromDisk(buildTarget, entityId)
    if (manifest) return manifest
    await new Promise((r) => setTimeout(r, 2000))
  }
  throw new Error(`Timed out waiting for manifest of ${entityId} after ${timeoutMs / 1000}s`)
}

// ---------------------------------------------------------------------------
// Test — uses the test runner from test/components.ts which manages the
// full server lifecycle (HTTP + in-memory queue + all components).
// ---------------------------------------------------------------------------

ensureUlf()
fs.mkdirSync(MOCK_S3_BASE, { recursive: true })
// Set mock-aws-s3 basePath BEFORE initComponents creates the S3 client.
// Without this, mock S3 writes to cwd instead of MOCK_S3_BASE.
MockAws.config.basePath = MOCK_S3_BASE

test('when converting scenes end-to-end via queue-task', ({ components }) => {
  let abVersion: string
  let assetsDir: string

  beforeAll(async () => {
    const abVersionEnvName = getAbVersionEnvName($BUILD_TARGET)
    abVersion = (await components.config.getString(abVersionEnvName)) || 'v48'
    assetsDir = path.join(MOCK_S3_BASE, BUCKET_NAME, abVersion, 'assets')
  })

  async function queueConversion(entityId: string, contentServerUrl: string): Promise<void> {
    // Publish directly to the in-memory queue — bypasses the HTTP handler
    // (which requires SNS) but still exercises the queue consumer loop in
    // service.ts that calls executeConversion.
    await components.taskQueue.publish({
      entity: {
        entityId,
        authChain: [{ type: AuthLinkType.SIGNER, payload: '0x0000000000000000000000000000000000000000', signature: '' }]
      },
      contentServerUrls: [contentServerUrl]
    })
  }

  for (let i = 0; i < SCENES.length; i++) {
    const sceneDef = SCENES[i]
    const sceneLabel = `Scene ${i + 1} (${sceneDef.name})`

    describe(`and converting ${sceneLabel}`, () => {
      let entityId: string
      let manifest: Manifest
      let filesBefore: number
      let mtimesBefore: Map<string, number>

      beforeAll(async () => {
        entityId = await resolveEntityId(sceneDef)
        filesBefore = countFiles(assetsDir)
        mtimesBefore = snapshotMtimes(assetsDir)

        await queueConversion(entityId, sceneDef.baseUrl)

        manifest = await waitForManifest($BUILD_TARGET, entityId)
      }, 600000)

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
        it('should not include broken hash in manifest', () => {
          const found = manifest.files.some((f: string) => f.startsWith(sceneDef.expectMissingHash!))
          expect(found).toBe(false)
        })
      }
    })
  }
})
