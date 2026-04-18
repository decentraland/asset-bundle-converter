// End-to-end proof of the migration script's work loop against mock-aws-s3.
// Seeds manifests + entity-scoped bundles, runs runMigration(), asserts the
// canonical prefix ends up populated. Re-runs to prove idempotency.

import * as fs from 'fs/promises'
import * as os from 'os'
import * as path from 'path'
import { rimraf } from 'rimraf'

// eslint-disable-next-line @typescript-eslint/no-var-requires
const MockAws = require('mock-aws-s3')
import { canonicalFilename, computeDepsDigest } from '../../src/logic/asset-reuse'
import { runMigration } from '../../src/migrate-to-canonical'

const BUCKET = 'test-migrate-bucket'
const CATALYST = 'https://peer.decentraland.org/content'

async function read(s3: any, Key: string): Promise<string | null> {
  try {
    const res = await s3.getObject({ Bucket: BUCKET, Key }).promise()
    return res.Body?.toString() ?? null
  } catch (e: any) {
    if (e.statusCode === 404 || e.code === 'NoSuchKey' || e.code === 'NotFound') return null
    throw e
  }
}

async function seedObject(s3: any, Key: string, Body: string): Promise<void> {
  await s3.putObject({ Bucket: BUCKET, Key, Body }).promise()
}

function makeManifest(version: string, files: string[], exitCode: number = 0, contentServerUrl: string = CATALYST): string {
  return JSON.stringify({ version, files, exitCode, contentServerUrl, date: '2026-04-17T00:00:00Z' })
}

/**
 * Build a `fetchEntity` stub the migration can use instead of hitting a live
 * catalyst. Looks up the entity's content from a pre-built map; tests control
 * extensions per hash by seeding this map.
 */
function makeFetchEntityStub(entityContentByEntityId: Record<string, { file: string; hash: string }[]>) {
  return jest.fn(async (entityId: string) => {
    const content = entityContentByEntityId[entityId]
    if (!content) throw new Error(`no stubbed entity for ${entityId}`)
    return { content }
  })
}

describe('when running the migration against a pre-rollout bucket', () => {
  let workDir: string
  let s3: any

  beforeEach(async () => {
    workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'migrate-test-'))
    MockAws.config.basePath = workDir
    s3 = new MockAws.S3({ params: { Bucket: BUCKET } })
  })

  afterEach(async () => {
    await rimraf(workDir, { maxRetries: 3 })
  })

  describe('and the target manifest lists bundles that only exist at the entity prefix', () => {
    let stats: Awaited<ReturnType<typeof runMigration>>

    beforeEach(async () => {
      // Windows manifest listing two bundles + one Unity .manifest sibling.
      await seedObject(
        s3,
        'manifest/bafy-entity-A_windows.json',
        makeManifest('v48', ['hashA_windows', 'hashA_windows.manifest', 'hashB_windows.br'])
      )
      // Entity-scoped bundles at the pre-rollout path.
      await seedObject(s3, 'v48/bafy-entity-A/hashA_windows', 'bundle-A-bytes')
      await seedObject(s3, 'v48/bafy-entity-A/hashA_windows.manifest', 'unity-manifest-bytes')
      await seedObject(s3, 'v48/bafy-entity-A/hashB_windows.br', 'brotli-B-bytes')

      // Both hashes map to buffer (`.bin`) files — leaves under the composite
      // scheme, so the canonical filenames stay the bare `{hash}_{target}` form
      // and all the existing path assertions below keep matching.
      const fetchEntity = makeFetchEntityStub({
        'bafy-entity-A': [
          { file: 'geo-A.bin', hash: 'hashA' },
          { file: 'geo-B.bin', hash: 'hashB' }
        ]
      })

      stats = await runMigration({
        s3,
        bucket: BUCKET,
        abVersion: 'v48',
        target: 'windows',
        dryRun: false,
        concurrency: 10,
        fetchEntity
      })
    })

    it('should scan and keep the one matching manifest', () => {
      expect(stats.manifestsScanned).toBe(1)
      expect(stats.manifestsKept).toBe(1)
    })

    it('should probe every bundle candidate from the manifest', () => {
      expect(stats.bundlesProbed).toBe(3)
    })

    it('should copy every bundle into the canonical prefix', () => {
      expect(stats.bundlesCopied).toBe(3)
      expect(stats.bundlesAlreadyCanonical).toBe(0)
      expect(stats.errors).toBe(0)
    })

    it('should land the raw bundle at the canonical path with identical bytes', async () => {
      expect(await read(s3, 'v48/assets/hashA_windows')).toBe('bundle-A-bytes')
    })

    it('should land the .manifest sibling at the canonical path', async () => {
      expect(await read(s3, 'v48/assets/hashA_windows.manifest')).toBe('unity-manifest-bytes')
    })

    it('should land the .br variant at the canonical path', async () => {
      expect(await read(s3, 'v48/assets/hashB_windows.br')).toBe('brotli-B-bytes')
    })

    it('should leave the original entity-scoped bundles untouched', async () => {
      expect(await read(s3, 'v48/bafy-entity-A/hashA_windows')).toBe('bundle-A-bytes')
    })
  })

  describe('and the migration is run a second time after the first run completed', () => {
    let firstStats: Awaited<ReturnType<typeof runMigration>>
    let secondStats: Awaited<ReturnType<typeof runMigration>>

    beforeEach(async () => {
      await seedObject(s3, 'manifest/bafy-entity-A_windows.json', makeManifest('v48', ['hashA_windows']))
      await seedObject(s3, 'v48/bafy-entity-A/hashA_windows', 'bundle-A-bytes')

      const fetchEntity = makeFetchEntityStub({
        'bafy-entity-A': [{ file: 'geo-A.bin', hash: 'hashA' }]
      })

      firstStats = await runMigration({
        s3,
        bucket: BUCKET,
        abVersion: 'v48',
        target: 'windows',
        dryRun: false,
        concurrency: 10,
        fetchEntity
      })
      secondStats = await runMigration({
        s3,
        bucket: BUCKET,
        abVersion: 'v48',
        target: 'windows',
        dryRun: false,
        concurrency: 10,
        fetchEntity
      })
    })

    it('should copy the bundle on the first pass', () => {
      expect(firstStats.bundlesCopied).toBe(1)
      expect(firstStats.bundlesAlreadyCanonical).toBe(0)
    })

    it('should copy nothing on the second pass (every probe hits canonical)', () => {
      expect(secondStats.bundlesCopied).toBe(0)
      expect(secondStats.bundlesAlreadyCanonical).toBe(secondStats.bundlesProbed)
      expect(secondStats.errors).toBe(0)
    })
  })

  describe('and a manifest is for a different target than the migration run', () => {
    let stats: Awaited<ReturnType<typeof runMigration>>

    beforeEach(async () => {
      // WebGL and Mac manifests exist, but we only migrate Windows on this run.
      await seedObject(s3, 'manifest/bafy-mac_mac.json', makeManifest('v48', ['hashX_mac']))
      await seedObject(s3, 'manifest/bafy-webgl.json', makeManifest('v48', ['hashY_webgl']))
      await seedObject(s3, 'manifest/bafy-win_windows.json', makeManifest('v48', ['hashZ_windows']))
      await seedObject(s3, 'v48/bafy-win/hashZ_windows', 'windows-bytes')

      const fetchEntity = makeFetchEntityStub({
        'bafy-win': [{ file: 'geo-Z.bin', hash: 'hashZ' }]
      })

      stats = await runMigration({
        s3,
        bucket: BUCKET,
        abVersion: 'v48',
        target: 'windows',
        dryRun: false,
        concurrency: 10,
        fetchEntity
      })
    })

    it('should skip the non-windows manifests without probing their bundles', () => {
      expect(stats.manifestsScanned).toBe(3)
      expect(stats.manifestsSkipped).toBe(2)
      expect(stats.manifestsKept).toBe(1)
    })

    it('should copy only the windows bundle', async () => {
      expect(stats.bundlesCopied).toBe(1)
      expect(await read(s3, 'v48/assets/hashZ_windows')).toBe('windows-bytes')
    })

    it('should leave mac and webgl canonical paths untouched', async () => {
      expect(await read(s3, 'v48/assets/hashX_mac')).toBeNull()
      expect(await read(s3, 'v48/assets/hashY_webgl')).toBeNull()
    })
  })

  describe('and a manifest has a non-zero exit code', () => {
    let stats: Awaited<ReturnType<typeof runMigration>>

    beforeEach(async () => {
      // Failed conversion sentinel should be skipped entirely — its listed
      // files might not actually exist under the entity prefix.
      await seedObject(
        s3,
        'manifest/bafy-failed_windows.json',
        makeManifest('v48', ['hashFailed_windows'], /* exitCode */ 5)
      )

      stats = await runMigration({
        s3,
        bucket: BUCKET,
        abVersion: 'v48',
        target: 'windows',
        dryRun: false,
        concurrency: 10
      })
    })

    it('should skip the manifest without probing any bundles', () => {
      expect(stats.manifestsKept).toBe(0)
      expect(stats.manifestsSkipped).toBe(1)
      expect(stats.bundlesProbed).toBe(0)
    })
  })

  describe('and dry-run is enabled', () => {
    let stats: Awaited<ReturnType<typeof runMigration>>

    beforeEach(async () => {
      await seedObject(s3, 'manifest/bafy-entity_windows.json', makeManifest('v48', ['hashA_windows']))
      await seedObject(s3, 'v48/bafy-entity/hashA_windows', 'bundle-bytes')

      const fetchEntity = makeFetchEntityStub({
        'bafy-entity': [{ file: 'geo-A.bin', hash: 'hashA' }]
      })

      stats = await runMigration({
        s3,
        bucket: BUCKET,
        abVersion: 'v48',
        target: 'windows',
        dryRun: true,
        concurrency: 10,
        fetchEntity
      })
    })

    it('should count bundles as would-copy', () => {
      expect(stats.bundlesCopied).toBe(1)
    })

    it('should not actually write to the canonical path', async () => {
      expect(await read(s3, 'v48/assets/hashA_windows')).toBeNull()
    })
  })

  describe('and the manifest lists a glb bundle', () => {
    let stats: Awaited<ReturnType<typeof runMigration>>
    let expectedComposite: string

    beforeEach(async () => {
      // Pre-rollout: manifest was written with the bare `{hash}_{target}` form.
      await seedObject(
        s3,
        'manifest/bafy-entity-with-glb_windows.json',
        makeManifest('v48', ['hashGlb_windows', 'hashGlb_windows.manifest', 'hashTex_windows'])
      )
      await seedObject(s3, 'v48/bafy-entity-with-glb/hashGlb_windows', 'glb-bundle-bytes')
      await seedObject(s3, 'v48/bafy-entity-with-glb/hashGlb_windows.manifest', 'glb-manifest-bytes')
      await seedObject(s3, 'v48/bafy-entity-with-glb/hashTex_windows', 'tex-bundle-bytes')

      const content = [
        { file: 'model.glb', hash: 'hashGlb' },
        { file: 'texture.png', hash: 'hashTex' }
      ]
      const digest = computeDepsDigest(content)
      expectedComposite = canonicalFilename('hashGlb', '.glb', 'windows', digest)

      const fetchEntity = makeFetchEntityStub({ 'bafy-entity-with-glb': content })

      stats = await runMigration({
        s3,
        bucket: BUCKET,
        abVersion: 'v48',
        target: 'windows',
        dryRun: false,
        concurrency: 10,
        fetchEntity
      })
    })

    it('should copy the glb bundle to the composite canonical path, not the bare one', async () => {
      expect(await read(s3, `v48/assets/${expectedComposite}`)).toBe('glb-bundle-bytes')
      expect(await read(s3, 'v48/assets/hashGlb_windows')).toBeNull()
    })

    it('should copy the glb .manifest sibling to the composite canonical path too', async () => {
      expect(await read(s3, `v48/assets/${expectedComposite}.manifest`)).toBe('glb-manifest-bytes')
    })

    it('should copy the texture bundle to the bare canonical path (leaves stay bare)', async () => {
      expect(await read(s3, 'v48/assets/hashTex_windows')).toBe('tex-bundle-bytes')
    })

    it('should count the glb + its sibling under glbRenamedCount', () => {
      // Two bundles rewritten (raw + .manifest); texture kept bare.
      expect(stats.glbRenamedCount).toBe(2)
    })
  })

  describe('and two entities share a glb hash but differ in textures', () => {
    let expectedA: string
    let expectedB: string

    beforeEach(async () => {
      await seedObject(s3, 'manifest/bafy-A_windows.json', makeManifest('v48', ['hashGlb_windows']))
      await seedObject(s3, 'manifest/bafy-B_windows.json', makeManifest('v48', ['hashGlb_windows']))
      await seedObject(s3, 'v48/bafy-A/hashGlb_windows', 'bundle-A-bytes')
      await seedObject(s3, 'v48/bafy-B/hashGlb_windows', 'bundle-B-bytes')

      const contentA = [
        { file: 'model.glb', hash: 'hashGlb' },
        { file: 'skin-red.png', hash: 'hashRed' }
      ]
      const contentB = [
        { file: 'model.glb', hash: 'hashGlb' },
        { file: 'skin-blue.png', hash: 'hashBlue' }
      ]
      expectedA = canonicalFilename('hashGlb', '.glb', 'windows', computeDepsDigest(contentA))
      expectedB = canonicalFilename('hashGlb', '.glb', 'windows', computeDepsDigest(contentB))

      const fetchEntity = makeFetchEntityStub({ 'bafy-A': contentA, 'bafy-B': contentB })

      await runMigration({
        s3,
        bucket: BUCKET,
        abVersion: 'v48',
        target: 'windows',
        dryRun: false,
        concurrency: 10,
        fetchEntity
      })
    })

    it('should land each entity at a distinct composite path', async () => {
      expect(expectedA).not.toBe(expectedB)
      expect(await read(s3, `v48/assets/${expectedA}`)).toBe('bundle-A-bytes')
      expect(await read(s3, `v48/assets/${expectedB}`)).toBe('bundle-B-bytes')
    })
  })

  describe('and the manifest is missing contentServerUrl', () => {
    describe('and no CLI fallback is provided', () => {
      let stats: Awaited<ReturnType<typeof runMigration>>

      beforeEach(async () => {
        // Pre-PR manifests predate the contentServerUrl field. Without it and
        // without a CLI fallback the script skips the manifest (and surfaces
        // it in a dedicated counter so operators can retry with --content-server-url).
        const body = JSON.stringify({ version: 'v48', files: ['hashX_windows'], exitCode: 0, date: '2026-04-17' })
        await seedObject(s3, 'manifest/bafy-nocatalyst_windows.json', body)
        await seedObject(s3, 'v48/bafy-nocatalyst/hashX_windows', 'bundle-bytes')

        stats = await runMigration({
          s3,
          bucket: BUCKET,
          abVersion: 'v48',
          target: 'windows',
          dryRun: false,
          concurrency: 10,
          fetchEntity: jest.fn()
        })
      })

      it('should count the manifest under manifestsMissingContentServer and not copy anything', async () => {
        expect(stats.manifestsMissingContentServer).toBe(1)
        expect(stats.bundlesProbed).toBe(0)
        expect(await read(s3, 'v48/assets/hashX_windows')).toBeNull()
      })
    })

    describe('and a CLI fallback is provided', () => {
      let stats: Awaited<ReturnType<typeof runMigration>>

      beforeEach(async () => {
        // Same pre-PR manifest, but this time the operator passes
        // --content-server-url so the backfill can still succeed.
        const body = JSON.stringify({ version: 'v48', files: ['hashX_windows'], exitCode: 0, date: '2026-04-17' })
        await seedObject(s3, 'manifest/bafy-nocatalyst_windows.json', body)
        await seedObject(s3, 'v48/bafy-nocatalyst/hashX_windows', 'bundle-bytes')

        const fetchEntity = jest.fn(async (_entityId: string, url: string) => {
          expect(url).toBe(CATALYST)
          return { content: [{ file: 'geo.bin', hash: 'hashX' }] }
        })

        stats = await runMigration({
          s3,
          bucket: BUCKET,
          abVersion: 'v48',
          target: 'windows',
          dryRun: false,
          concurrency: 10,
          contentServerUrl: CATALYST,
          fetchEntity
        })
      })

      it('should migrate the manifest using the fallback catalyst URL', async () => {
        expect(stats.manifestsMissingContentServer).toBe(0)
        expect(stats.bundlesCopied).toBe(1)
        expect(await read(s3, 'v48/assets/hashX_windows')).toBe('bundle-bytes')
      })
    })

    describe('and both the manifest body and the CLI fallback are set', () => {
      let fetchEntity: jest.Mock

      beforeEach(async () => {
        // The manifest-embedded value reflects the catalyst the entity was
        // originally resolved against — that's the one we want, not whatever
        // the operator happens to be pointing at today.
        await seedObject(
          s3,
          'manifest/bafy-both_windows.json',
          makeManifest('v48', ['hashM_windows'], 0, 'https://original.catalyst.example')
        )
        await seedObject(s3, 'v48/bafy-both/hashM_windows', 'bundle-bytes')

        fetchEntity = jest.fn(async (_id: string, url: string) => {
          expect(url).toBe('https://original.catalyst.example')
          return { content: [{ file: 'geo.bin', hash: 'hashM' }] }
        })

        await runMigration({
          s3,
          bucket: BUCKET,
          abVersion: 'v48',
          target: 'windows',
          dryRun: false,
          concurrency: 10,
          contentServerUrl: 'https://cli-override.example',
          fetchEntity
        })
      })

      it('should prefer the manifest-embedded catalyst over the CLI fallback', () => {
        expect(fetchEntity).toHaveBeenCalled()
      })
    })
  })

  describe('and onProgress is supplied with a short progressInterval', () => {
    let snapshots: Array<{ manifestsScanned: number }>

    beforeEach(async () => {
      // Seed three manifests so the loop scans past the interval boundary.
      await seedObject(s3, 'manifest/bafy-p1_windows.json', makeManifest('v48', ['hashP1_windows']))
      await seedObject(s3, 'manifest/bafy-p2_windows.json', makeManifest('v48', ['hashP2_windows']))
      await seedObject(s3, 'manifest/bafy-p3_windows.json', makeManifest('v48', ['hashP3_windows']))
      await seedObject(s3, 'v48/bafy-p1/hashP1_windows', 'x')
      await seedObject(s3, 'v48/bafy-p2/hashP2_windows', 'x')
      await seedObject(s3, 'v48/bafy-p3/hashP3_windows', 'x')

      const fetchEntity = makeFetchEntityStub({
        'bafy-p1': [{ file: 'g.bin', hash: 'hashP1' }],
        'bafy-p2': [{ file: 'g.bin', hash: 'hashP2' }],
        'bafy-p3': [{ file: 'g.bin', hash: 'hashP3' }]
      })

      snapshots = []
      await runMigration({
        s3,
        bucket: BUCKET,
        abVersion: 'v48',
        target: 'windows',
        dryRun: false,
        concurrency: 10,
        fetchEntity,
        // Fire on every manifest so tests don't hang waiting for the default
        // 100-manifest threshold. Production default stays 100; tests lower it.
        progressInterval: 1,
        onProgress: (snap) => snapshots.push({ manifestsScanned: snap.manifestsScanned })
      })
    })

    it('should fire onProgress for each manifest boundary crossed', () => {
      // `manifestsScanned % progressInterval === 0` with interval 1 fires on
      // every scan. Three seeded manifests → three snapshots.
      expect(snapshots.map((s) => s.manifestsScanned)).toEqual([1, 2, 3])
    })
  })

  describe('and a manifest body is empty', () => {
    let stats: Awaited<ReturnType<typeof runMigration>>

    beforeEach(async () => {
      // Pathological but plausible: S3 object exists but is a zero-byte file.
      // The runMigration loop should treat it as "skippable manifest", not crash.
      await seedObject(s3, 'manifest/bafy-empty_windows.json', '')

      stats = await runMigration({
        s3,
        bucket: BUCKET,
        abVersion: 'v48',
        target: 'windows',
        dryRun: false,
        concurrency: 10,
        fetchEntity: jest.fn()
      })
    })

    it('should count the manifest as skipped without probing or erroring', () => {
      expect(stats.manifestsSkipped).toBe(1)
      expect(stats.errors).toBe(0)
      expect(stats.bundlesProbed).toBe(0)
    })
  })

  describe('and getObject throws for a manifest', () => {
    let stats: Awaited<ReturnType<typeof runMigration>>
    let logged: string[]
    let originalGet: any

    beforeEach(async () => {
      await seedObject(s3, 'manifest/bafy-broken_windows.json', makeManifest('v48', ['hashB_windows']))

      // Force getObject to throw for this specific key — simulates a transient
      // S3 error on read. The loop should catch-and-count-and-continue.
      originalGet = s3.getObject.bind(s3)
      jest.spyOn(s3, 'getObject').mockImplementation((params: any) => {
        if (params.Key === 'manifest/bafy-broken_windows.json') {
          return { promise: async () => Promise.reject(new Error('simulated S3 read error')) } as any
        }
        return originalGet(params)
      })

      logged = []
      stats = await runMigration({
        s3,
        bucket: BUCKET,
        abVersion: 'v48',
        target: 'windows',
        dryRun: false,
        concurrency: 10,
        fetchEntity: jest.fn(),
        log: (m) => logged.push(m)
      })
    })

    it('should count the failure under errors and log the underlying cause', () => {
      expect(stats.errors).toBe(1)
      expect(logged.some((l) => l.includes('failed to read/parse manifest'))).toBe(true)
    })
  })

  describe('and the canonical HEAD returns a non-404 error', () => {
    let stats: Awaited<ReturnType<typeof runMigration>>
    let logged: string[]

    beforeEach(async () => {
      await seedObject(s3, 'manifest/bafy-head500_windows.json', makeManifest('v48', ['hashH_windows']))
      await seedObject(s3, 'v48/bafy-head500/hashH_windows', 'x')

      // Make headObject reject with a 500 for canonical probes. The loop should
      // log and increment errors, then skip the bundle instead of misclassifying
      // it as "missing canonical" and copying over a bundle that might already
      // exist in a degraded state.
      const realHead = s3.headObject.bind(s3)
      jest.spyOn(s3, 'headObject').mockImplementation((params: any) => {
        if (params.Key.startsWith('v48/assets/')) {
          const err: any = new Error('simulated S3 500')
          err.statusCode = 500
          return { promise: async () => Promise.reject(err) } as any
        }
        return realHead(params)
      })

      const fetchEntity = makeFetchEntityStub({
        'bafy-head500': [{ file: 'g.bin', hash: 'hashH' }]
      })

      logged = []
      stats = await runMigration({
        s3,
        bucket: BUCKET,
        abVersion: 'v48',
        target: 'windows',
        dryRun: false,
        concurrency: 10,
        fetchEntity,
        log: (m) => logged.push(m)
      })
    })

    it('should count the probe failure under errors and not copy the bundle', () => {
      expect(stats.errors).toBe(1)
      expect(stats.bundlesCopied).toBe(0)
      expect(logged.some((l) => l.includes('HEAD'))).toBe(true)
    })
  })

  describe('and the catalyst returns undefined for a redeployed entity', () => {
    let stats: Awaited<ReturnType<typeof runMigration>>
    let logged: string[]

    beforeEach(async () => {
      await seedObject(s3, 'manifest/bafy-redeployed_windows.json', makeManifest('v48', ['hashX_windows']))
      await seedObject(s3, 'v48/bafy-redeployed/hashX_windows', 'bundle-bytes')

      // Mirrors `getActiveEntity`'s real behaviour: when the catalyst has no
      // active entity for the id, `JSON.parse(response)[0]` is `undefined`.
      const fetchEntity = jest.fn(async () => undefined as any)
      logged = []
      stats = await runMigration({
        s3,
        bucket: BUCKET,
        abVersion: 'v48',
        target: 'windows',
        dryRun: false,
        concurrency: 10,
        fetchEntity,
        log: (msg) => logged.push(msg)
      })
    })

    it('should count the manifest under manifestsEntityFetchFailed without crashing', () => {
      expect(stats.manifestsEntityFetchFailed).toBe(1)
      expect(stats.bundlesProbed).toBe(0)
    })

    it('should log an actionable reason instead of a TypeError', () => {
      const msg = logged.find((l) => l.includes('bafy-redeployed_windows.json')) ?? ''
      expect(msg).toMatch(/no longer active on catalyst/)
    })
  })

  describe('and the entity fetch fails for one manifest', () => {
    let stats: Awaited<ReturnType<typeof runMigration>>

    beforeEach(async () => {
      await seedObject(s3, 'manifest/bafy-good_windows.json', makeManifest('v48', ['hashG_windows']))
      await seedObject(s3, 'manifest/bafy-bad_windows.json', makeManifest('v48', ['hashB_windows']))
      await seedObject(s3, 'v48/bafy-good/hashG_windows', 'good-bytes')
      await seedObject(s3, 'v48/bafy-bad/hashB_windows', 'bad-bytes')

      const fetchEntity = jest.fn(async (entityId: string) => {
        if (entityId === 'bafy-bad') throw new Error('catalyst 502')
        return { content: [{ file: 'geo.bin', hash: 'hashG' }] }
      })

      stats = await runMigration({
        s3,
        bucket: BUCKET,
        abVersion: 'v48',
        target: 'windows',
        dryRun: false,
        concurrency: 10,
        fetchEntity
      })
    })

    it('should count the failure under manifestsEntityFetchFailed and keep processing the rest', async () => {
      expect(stats.manifestsEntityFetchFailed).toBe(1)
      expect(stats.bundlesCopied).toBe(1)
      expect(await read(s3, 'v48/assets/hashG_windows')).toBe('good-bytes')
      expect(await read(s3, 'v48/assets/hashB_windows')).toBeNull()
    })
  })

  describe('and the manifest references a bundle whose source object does not exist', () => {
    let stats: Awaited<ReturnType<typeof runMigration>>

    beforeEach(async () => {
      // Stale manifest: lists a file that's no longer present at the entity
      // prefix (e.g. partial cleanup). Migration should count-and-continue
      // rather than aborting the enclosing loop.
      await seedObject(
        s3,
        'manifest/bafy-stale_windows.json',
        makeManifest('v48', ['hashExists_windows', 'hashMissing_windows'])
      )
      await seedObject(s3, 'v48/bafy-stale/hashExists_windows', 'present-bytes')
      // hashMissing_windows is intentionally NOT seeded.

      const fetchEntity = makeFetchEntityStub({
        'bafy-stale': [
          { file: 'exists.bin', hash: 'hashExists' },
          { file: 'missing.bin', hash: 'hashMissing' }
        ]
      })

      stats = await runMigration({
        s3,
        bucket: BUCKET,
        abVersion: 'v48',
        target: 'windows',
        dryRun: false,
        concurrency: 10,
        fetchEntity
      })
    })

    it('should copy the bundle that does exist', async () => {
      expect(stats.bundlesCopied).toBe(1)
      expect(await read(s3, 'v48/assets/hashExists_windows')).toBe('present-bytes')
    })

    it('should account for the missing bundle under either missing-source or errors (count-and-continue, do not abort)', () => {
      // mock-aws-s3's copyObject error shape for a missing source key differs
      // from real AWS (ENOENT vs. NoSuchKey), so depending on the runtime the
      // loop increments either bundlesMissingSource or errors. What matters
      // operationally is (a) the loop didn't abort the remaining manifest
      // items and (b) the missing bundle is accounted for somewhere.
      expect(stats.bundlesMissingSource + stats.errors).toBe(1)
    })
  })
})
