// End-to-end proof of the migration script's work loop against mock-aws-s3.
// Seeds manifests + entity-scoped bundles, runs runMigration(), asserts the
// canonical prefix ends up populated. Re-runs to prove idempotency.

import * as fs from 'fs/promises'
import * as os from 'os'
import * as path from 'path'
import { rimraf } from 'rimraf'

// eslint-disable-next-line @typescript-eslint/no-var-requires
const MockAws = require('mock-aws-s3')
import { runMigration } from '../../src/migrate-to-canonical'

const BUCKET = 'test-migrate-bucket'

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

function makeManifest(version: string, files: string[], exitCode: number = 0): string {
  return JSON.stringify({ version, files, exitCode, date: '2026-04-17T00:00:00Z' })
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

      stats = await runMigration({
        s3,
        bucket: BUCKET,
        abVersion: 'v48',
        target: 'windows',
        dryRun: false,
        concurrency: 10
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

      firstStats = await runMigration({
        s3,
        bucket: BUCKET,
        abVersion: 'v48',
        target: 'windows',
        dryRun: false,
        concurrency: 10
      })
      secondStats = await runMigration({
        s3,
        bucket: BUCKET,
        abVersion: 'v48',
        target: 'windows',
        dryRun: false,
        concurrency: 10
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

      stats = await runMigration({
        s3,
        bucket: BUCKET,
        abVersion: 'v48',
        target: 'windows',
        dryRun: false,
        concurrency: 10
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

      stats = await runMigration({
        s3,
        bucket: BUCKET,
        abVersion: 'v48',
        target: 'windows',
        dryRun: true,
        concurrency: 10
      })
    })

    it('should count bundles as would-copy', () => {
      expect(stats.bundlesCopied).toBe(1)
    })

    it('should not actually write to the canonical path', async () => {
      expect(await read(s3, 'v48/assets/hashA_windows')).toBeNull()
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

      stats = await runMigration({
        s3,
        bucket: BUCKET,
        abVersion: 'v48',
        target: 'windows',
        dryRun: false,
        concurrency: 10
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
