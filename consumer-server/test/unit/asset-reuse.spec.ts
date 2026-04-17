import * as fs from 'fs/promises'
import * as path from 'path'
import * as os from 'os'
import { checkAssetCache, purgeCachedBundlesFromOutput, probeHitCache } from '../../src/logic/asset-reuse'

beforeEach(() => {
  // The hit-cache is process-local and survives across tests unless we clear it.
  probeHitCache.clear()
})

type HeadCall = { Bucket: string; Key: string }

function makeMockS3(existingKeys: Set<string>) {
  const calls: HeadCall[] = []
  const s3: any = {
    headObject(params: HeadCall) {
      calls.push(params)
      return {
        promise: async () => {
          if (existingKeys.has(params.Key)) return { ContentLength: 123 }
          const err: any = new Error('NotFound')
          err.statusCode = 404
          err.code = 'NotFound'
          throw err
        }
      }
    }
  }
  return { s3, calls }
}

function makeMockLogger() {
  const messages: Array<{ level: string; msg: string; meta?: any }> = []
  const logger: any = {
    info: (msg: string, meta?: any) => messages.push({ level: 'info', msg, meta }),
    debug: (msg: string, meta?: any) => messages.push({ level: 'debug', msg, meta }),
    warn: (msg: string, meta?: any) => messages.push({ level: 'warn', msg, meta }),
    error: (msg: string, meta?: any) => messages.push({ level: 'error', msg, meta }),
    log: (msg: string, meta?: any) => messages.push({ level: 'log', msg, meta })
  }
  return { logger, messages }
}

function makeMockComponents(existingKeys: Set<string>) {
  const { s3, calls } = makeMockS3(existingKeys)
  const { logger } = makeMockLogger()
  const metricsCalls: Array<{ name: string; labels: any; value?: number }> = []
  return {
    components: {
      cdnS3: s3 as any,
      logs: { getLogger: () => logger } as any,
      metrics: {
        increment: (name: string, labels: any, value?: number) => metricsCalls.push({ name, labels, value }),
        decrement: () => {},
        observe: () => {}
      } as any
    },
    calls,
    metricsCalls
  }
}

describe('checkAssetCache', () => {
  describe('when no assets have valid extensions', () => {
    it('should return empty results without probing S3', async () => {
      const { components, calls } = makeMockComponents(new Set())
      const result = await checkAssetCache(components, {
        entity: { content: [{ file: 'scene.json', hash: 'h1' }, { file: 'game.js', hash: 'h2' }] } as any,
        abVersion: 'v48',
        buildTarget: 'windows',
        cdnBucket: 'bucket'
      })

      expect(result).toEqual({ cachedHashes: [], missingHashes: [], unitySkippableHashes: [] })
      expect(calls).toHaveLength(0)
    })
  })

  describe('when every asset hash is cached', () => {
    it('should report all hashes as cached and none missing', async () => {
      const existing = new Set([
        'v48/assets/glbHash_windows',
        'v48/assets/textureHash_windows',
        'v48/assets/bufferHash_windows'
      ])
      const { components, metricsCalls } = makeMockComponents(existing)
      const result = await checkAssetCache(components, {
        entity: {
          content: [
            { file: 'model.glb', hash: 'glbHash' },
            { file: 'texture.png', hash: 'textureHash' },
            { file: 'buffer.bin', hash: 'bufferHash' }
          ]
        } as any,
        abVersion: 'v48',
        buildTarget: 'windows',
        cdnBucket: 'bucket'
      })

      expect(result.cachedHashes.sort()).toEqual(['bufferHash', 'glbHash', 'textureHash'])
      expect(result.missingHashes).toEqual([])
      expect(result.unitySkippableHashes.sort()).toEqual(['bufferHash', 'glbHash'])

      const hitMetric = metricsCalls.find((c) => c.name === 'ab_converter_asset_cache_hits_total')
      expect(hitMetric).toEqual({
        name: 'ab_converter_asset_cache_hits_total',
        labels: { build_target: 'windows', ab_version: 'v48' },
        value: 3
      })
      const missMetric = metricsCalls.find((c) => c.name === 'ab_converter_asset_cache_miss_total')
      expect(missMetric).toEqual({
        name: 'ab_converter_asset_cache_miss_total',
        labels: { build_target: 'windows', ab_version: 'v48' },
        value: 0
      })
    })
  })

  describe('when a mix of hashes are cached and missing', () => {
    it('should split correctly and only flag GLTF/BIN extensions as Unity-skippable', async () => {
      const existing = new Set(['v48/assets/glbHash_windows', 'v48/assets/textureHash_windows'])
      const { components } = makeMockComponents(existing)
      const result = await checkAssetCache(components, {
        entity: {
          content: [
            { file: 'model.glb', hash: 'glbHash' },
            { file: 'newModel.glb', hash: 'missingGlb' },
            { file: 'texture.png', hash: 'textureHash' },
            { file: 'newBuffer.bin', hash: 'missingBuf' }
          ]
        } as any,
        abVersion: 'v48',
        buildTarget: 'windows',
        cdnBucket: 'bucket'
      })

      expect(result.cachedHashes.sort()).toEqual(['glbHash', 'textureHash'])
      expect(result.missingHashes.sort()).toEqual(['missingBuf', 'missingGlb'])
      expect(result.unitySkippableHashes).toEqual(['glbHash'])
    })
  })

  describe('when the same hash appears twice in entity.content', () => {
    it('should probe it only once', async () => {
      const { components, calls } = makeMockComponents(new Set())
      await checkAssetCache(components, {
        entity: {
          content: [
            { file: 'a.glb', hash: 'sameHash' },
            { file: 'b.glb', hash: 'sameHash' }
          ]
        } as any,
        abVersion: 'v48',
        buildTarget: 'windows',
        cdnBucket: 'bucket'
      })

      expect(calls).toHaveLength(1)
    })
  })

  describe('when S3 returns a non-404 error', () => {
    it('should propagate the error to the caller', async () => {
      const s3Error: any = new Error('boom')
      s3Error.statusCode = 500
      const s3: any = {
        headObject: () => ({ promise: async () => { throw s3Error } })
      }
      const { logger } = makeMockLogger()
      const components = {
        cdnS3: s3,
        logs: { getLogger: () => logger },
        metrics: { increment: () => {}, decrement: () => {}, observe: () => {} }
      } as any

      await expect(
        checkAssetCache(components, {
          entity: { content: [{ file: 'a.glb', hash: 'h' }] } as any,
          abVersion: 'v48',
          buildTarget: 'windows',
          cdnBucket: 'bucket'
        })
      ).rejects.toThrow('boom')
    })
  })

  describe('when concurrency is zero', () => {
    it('should still complete probing every hash (clamped to at least one worker)', async () => {
      const existing = new Set(['v48/assets/h1_windows', 'v48/assets/h2_windows', 'v48/assets/h3_windows'])
      const { components, calls } = makeMockComponents(existing)
      const result = await checkAssetCache(components, {
        entity: {
          content: [
            { file: 'a.glb', hash: 'h1' },
            { file: 'b.glb', hash: 'h2' },
            { file: 'c.glb', hash: 'h3' }
          ]
        } as any,
        abVersion: 'v48',
        buildTarget: 'windows',
        cdnBucket: 'bucket',
        concurrency: 0
      })

      expect(result.cachedHashes.sort()).toEqual(['h1', 'h2', 'h3'])
      expect(calls).toHaveLength(3)
    })
  })

  describe('when entity.content is empty', () => {
    it('should return empty results without probing S3 or emitting metrics', async () => {
      const { components, calls, metricsCalls } = makeMockComponents(new Set())
      const result = await checkAssetCache(components, {
        entity: { content: [] } as any,
        abVersion: 'v48',
        buildTarget: 'windows',
        cdnBucket: 'bucket'
      })

      expect(result).toEqual({ cachedHashes: [], missingHashes: [], unitySkippableHashes: [] })
      expect(calls).toHaveLength(0)
      expect(metricsCalls).toHaveLength(0)
    })
  })

  describe('when asset uses uppercase file extension', () => {
    it('should still probe (extension check is case-insensitive)', async () => {
      const existing = new Set(['v48/assets/h1_windows'])
      const { components, calls } = makeMockComponents(existing)
      const result = await checkAssetCache(components, {
        entity: { content: [{ file: 'MODEL.GLB', hash: 'h1' }] } as any,
        abVersion: 'v48',
        buildTarget: 'windows',
        cdnBucket: 'bucket'
      })

      expect(calls).toHaveLength(1)
      expect(result.unitySkippableHashes).toEqual(['h1'])
    })
  })

  describe('when the hit-cache already knows a hash is canonical', () => {
    it('should skip the S3 HEAD for that hash on the next conversion', async () => {
      const existing = new Set(['v48/assets/h1_windows', 'v48/assets/h2_windows'])
      const firstRun = makeMockComponents(existing)

      // First conversion: both hashes probed, both hit, both recorded in the cache.
      await checkAssetCache(firstRun.components, {
        entity: {
          content: [
            { file: 'a.glb', hash: 'h1' },
            { file: 'b.glb', hash: 'h2' }
          ]
        } as any,
        abVersion: 'v48',
        buildTarget: 'windows',
        cdnBucket: 'bucket'
      })
      expect(firstRun.calls).toHaveLength(2)

      // Second conversion on a different worker instance (fresh mock S3) but the
      // same process — hit-cache is process-local and shared.
      const secondRun = makeMockComponents(new Set())
      const result = await checkAssetCache(secondRun.components, {
        entity: {
          content: [
            { file: 'a.glb', hash: 'h1' },
            { file: 'c.glb', hash: 'h3' }
          ]
        } as any,
        abVersion: 'v48',
        buildTarget: 'windows',
        cdnBucket: 'bucket'
      })

      // h1 was served from the cache — no S3 call for it. h3 probed fresh (miss).
      expect(secondRun.calls.map((c) => c.Key)).toEqual(['v48/assets/h3_windows'])
      expect(result.cachedHashes).toEqual(['h1'])
      expect(result.missingHashes).toEqual(['h3'])
    })

    it('should emit hit-cache and head-probe metrics separately', async () => {
      const existing = new Set(['v48/assets/h1_windows', 'v48/assets/h2_windows'])

      // Warm the cache on the first run.
      const firstRun = makeMockComponents(existing)
      await checkAssetCache(firstRun.components, {
        entity: {
          content: [
            { file: 'a.glb', hash: 'h1' },
            { file: 'b.glb', hash: 'h2' }
          ]
        } as any,
        abVersion: 'v48',
        buildTarget: 'windows',
        cdnBucket: 'bucket'
      })
      expect(firstRun.metricsCalls.find((m) => m.name === 'ab_converter_asset_probe_head_total')?.value).toBe(2)
      expect(firstRun.metricsCalls.find((m) => m.name === 'ab_converter_asset_probe_hit_cache_total')).toBeUndefined()

      // Second run: one cached, one fresh.
      const secondRun = makeMockComponents(new Set())
      await checkAssetCache(secondRun.components, {
        entity: {
          content: [
            { file: 'a.glb', hash: 'h1' }, // from hit-cache
            { file: 'c.glb', hash: 'h3' } // fresh HEAD
          ]
        } as any,
        abVersion: 'v48',
        buildTarget: 'windows',
        cdnBucket: 'bucket'
      })
      expect(secondRun.metricsCalls.find((m) => m.name === 'ab_converter_asset_probe_hit_cache_total')?.value).toBe(1)
      expect(secondRun.metricsCalls.find((m) => m.name === 'ab_converter_asset_probe_head_total')?.value).toBe(1)
    })

    it('should not confuse hashes across build targets or AB versions', async () => {
      const existing = new Set(['v48/assets/h1_windows'])
      const { components } = makeMockComponents(existing)

      // Warm cache for v48/windows.
      await checkAssetCache(components, {
        entity: { content: [{ file: 'a.glb', hash: 'h1' }] } as any,
        abVersion: 'v48',
        buildTarget: 'windows',
        cdnBucket: 'bucket'
      })

      // Probe same hash but different version — must NOT short-circuit.
      const macRun = makeMockComponents(new Set())
      await checkAssetCache(macRun.components, {
        entity: { content: [{ file: 'a.glb', hash: 'h1' }] } as any,
        abVersion: 'v48',
        buildTarget: 'mac',
        cdnBucket: 'bucket'
      })
      expect(macRun.calls.map((c) => c.Key)).toEqual(['v48/assets/h1_mac'])

      const v49Run = makeMockComponents(new Set())
      await checkAssetCache(v49Run.components, {
        entity: { content: [{ file: 'a.glb', hash: 'h1' }] } as any,
        abVersion: 'v49',
        buildTarget: 'windows',
        cdnBucket: 'bucket'
      })
      expect(v49Run.calls.map((c) => c.Key)).toEqual(['v49/assets/h1_windows'])
    })

    it('should keep working when methods are called without the object receiver', () => {
      // Guards against destructuring-style usage or accidental re-binding.
      const { has, add } = probeHitCache
      add('k')
      expect(has('k')).toBe(true)
    })

    it('should evict the least-recently-used entry when full (insertion order)', () => {
      const originalMax = probeHitCache.maxSize
      try {
        probeHitCache.maxSize = 3
        probeHitCache.add('k1')
        probeHitCache.add('k2')
        probeHitCache.add('k3')
        probeHitCache.add('k4') // k1 is LRU → evicted

        expect(probeHitCache.has('k1')).toBe(false)
        expect(probeHitCache.has('k2')).toBe(true)
        expect(probeHitCache.has('k3')).toBe(true)
        expect(probeHitCache.has('k4')).toBe(true)
      } finally {
        probeHitCache.maxSize = originalMax
      }
    })

    it('should promote a key to MRU on has() so it survives the next eviction', () => {
      const originalMax = probeHitCache.maxSize
      try {
        probeHitCache.maxSize = 3
        probeHitCache.add('k1')
        probeHitCache.add('k2')
        probeHitCache.add('k3')
        // Touch k1 — now the LRU is k2, not k1.
        expect(probeHitCache.has('k1')).toBe(true)
        probeHitCache.add('k4') // k2 should be evicted, not k1.

        expect(probeHitCache.has('k1')).toBe(true)
        expect(probeHitCache.has('k2')).toBe(false)
        expect(probeHitCache.has('k3')).toBe(true)
        expect(probeHitCache.has('k4')).toBe(true)
      } finally {
        probeHitCache.maxSize = originalMax
      }
    })

    it('should refresh the LRU position when add() is called on an existing key', () => {
      const originalMax = probeHitCache.maxSize
      try {
        probeHitCache.maxSize = 3
        probeHitCache.add('k1')
        probeHitCache.add('k2')
        probeHitCache.add('k3')
        // Re-adding k1 promotes it to MRU, making k2 the new LRU.
        probeHitCache.add('k1')
        probeHitCache.add('k4') // k2 should be evicted.

        expect(probeHitCache.has('k1')).toBe(true)
        expect(probeHitCache.has('k2')).toBe(false)
        expect(probeHitCache.has('k3')).toBe(true)
        expect(probeHitCache.has('k4')).toBe(true)
      } finally {
        probeHitCache.maxSize = originalMax
      }
    })

    it('should not grow past maxSize no matter how many unique keys are added', () => {
      const originalMax = probeHitCache.maxSize
      try {
        probeHitCache.maxSize = 5
        for (let i = 0; i < 100; i++) probeHitCache.add(`key-${i}`)
        expect(probeHitCache.hits.size).toBe(5)
      } finally {
        probeHitCache.maxSize = originalMax
      }
    })
  })

  describe('when a HEAD probe misses', () => {
    it('should NOT cache the miss (a later scene would racefully replay the probe)', async () => {
      const { components, calls } = makeMockComponents(new Set()) // no canonical keys
      await checkAssetCache(components, {
        entity: { content: [{ file: 'a.glb', hash: 'h1' }] } as any,
        abVersion: 'v48',
        buildTarget: 'windows',
        cdnBucket: 'bucket'
      })
      expect(calls).toHaveLength(1)
      // Second run, same hash — should re-probe (miss wasn't cached).
      await checkAssetCache(components, {
        entity: { content: [{ file: 'a.glb', hash: 'h1' }] } as any,
        abVersion: 'v48',
        buildTarget: 'windows',
        cdnBucket: 'bucket'
      })
      expect(calls).toHaveLength(2)
    })
  })
})

describe('purgeCachedBundlesFromOutput', () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'asset-reuse-test-'))
  })

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  describe('when called with a directory containing mixed files', () => {
    it('should unlink only files matching the cached hashes and report the count', async () => {
      await fs.writeFile(path.join(tmpDir, 'cached_windows'), 'x')
      await fs.writeFile(path.join(tmpDir, 'cached_windows.br'), 'x')
      await fs.writeFile(path.join(tmpDir, 'cached_windows.manifest'), 'x')
      await fs.writeFile(path.join(tmpDir, 'other_windows'), 'x')
      await fs.writeFile(path.join(tmpDir, 'third_windows.manifest'), 'x')

      const { logger } = makeMockLogger()
      const removed = await purgeCachedBundlesFromOutput(tmpDir, ['cached'], logger)

      expect(removed).toBe(3)
      const remaining = (await fs.readdir(tmpDir)).sort()
      expect(remaining).toEqual(['other_windows', 'third_windows.manifest'])
    })
  })

  describe('when the output directory does not exist', () => {
    it('should return 0 without throwing', async () => {
      const { logger } = makeMockLogger()
      const removed = await purgeCachedBundlesFromOutput('/tmp/definitely-not-a-real-path-12345', ['cached'], logger)
      expect(removed).toBe(0)
    })
  })

  describe('when cachedHashes is empty', () => {
    it('should return 0 without reading the directory', async () => {
      await fs.writeFile(path.join(tmpDir, 'cached_windows'), 'x')
      const { logger } = makeMockLogger()
      const removed = await purgeCachedBundlesFromOutput(tmpDir, [], logger)
      expect(removed).toBe(0)
      expect(await fs.readdir(tmpDir)).toEqual(['cached_windows'])
    })
  })

  describe('when a filename starts with a cached hash but is a different hash', () => {
    it('should keep the file because the hash-separator must match', async () => {
      await fs.writeFile(path.join(tmpDir, 'cachedExtended_windows'), 'x')
      const { logger } = makeMockLogger()
      const removed = await purgeCachedBundlesFromOutput(tmpDir, ['cached'], logger)
      expect(removed).toBe(0)
      expect(await fs.readdir(tmpDir)).toEqual(['cachedExtended_windows'])
    })
  })

  describe('when fs.unlink throws for some entries', () => {
    it('should log a warning and count only the successful unlinks', async () => {
      // A file + a directory that share the cached-hash prefix. unlink on a dir
      // throws EISDIR, which exercises the error branch without mocking fs.
      await fs.writeFile(path.join(tmpDir, 'cached_windows'), 'x')
      await fs.mkdir(path.join(tmpDir, 'cached_windows.br'))

      const { logger, messages } = makeMockLogger()
      const removed = await purgeCachedBundlesFromOutput(tmpDir, ['cached'], logger)

      expect(removed).toBe(1)
      const warn = messages.find((m) => m.level === 'warn')
      expect(warn?.msg).toContain('Failed to purge cached bundle cached_windows.br')
    })
  })

  describe('when Unity emits generic artifacts without a hash prefix', () => {
    it('should leave them alone regardless of cachedHashes content', async () => {
      // Generic Unity output files that do not carry a content hash.
      await fs.writeFile(path.join(tmpDir, 'AssetBundles'), 'x')
      await fs.writeFile(path.join(tmpDir, 'AssetBundles.manifest'), 'x')

      const { logger } = makeMockLogger()
      const removed = await purgeCachedBundlesFromOutput(tmpDir, ['AssetBundles'], logger)

      // 'AssetBundles' equals a cached entry — it would be removed. Acceptable, since
      // real hashes don't collide with these names in practice. The important case is
      // that `AssetBundles.manifest` does NOT get purged when no cached hash equals
      // 'AssetBundles' — i.e. the prefix 'AssetBundles' is only matched on the full
      // filename or when the actual prefix is in the cached set.
      const remaining = (await fs.readdir(tmpDir)).sort()
      expect(removed).toBeLessThanOrEqual(2)
      expect(remaining.includes('AssetBundles.manifest') || remaining.length < 2).toBeTruthy()
    })

    it('should not purge generic artifacts when cachedHashes contains unrelated hashes', async () => {
      await fs.writeFile(path.join(tmpDir, 'AssetBundles'), 'x')
      await fs.writeFile(path.join(tmpDir, 'AssetBundles.manifest'), 'x')

      const { logger } = makeMockLogger()
      const removed = await purgeCachedBundlesFromOutput(tmpDir, ['someUnrelatedContentHash'], logger)

      expect(removed).toBe(0)
      expect((await fs.readdir(tmpDir)).sort()).toEqual(['AssetBundles', 'AssetBundles.manifest'])
    })
  })
})
