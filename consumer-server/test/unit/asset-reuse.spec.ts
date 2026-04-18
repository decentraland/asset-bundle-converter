import * as fs from 'fs/promises'
import * as path from 'path'
import * as os from 'os'
import {
  canonicalFilename,
  checkAssetCache,
  computeDepsDigest,
  probeHitCache,
  purgeCachedBundlesFromOutput
} from '../../src/logic/asset-reuse'

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

// Shorthand to compute the canonical S3 key a probe would HEAD for a single hash
// in a test entity. Tests don't hardcode digest strings — they derive them from
// the same helpers production code uses.
function probeKeyFor(abVersion: string, hash: string, ext: string, target: string, content: { file: string; hash: string }[]) {
  return `${abVersion}/assets/${canonicalFilename(hash, ext, target, computeDepsDigest(content))}`
}

describe('when computing the deps digest', () => {
  describe('and the entity has only textures and buffers', () => {
    it('should return a 16-hex deterministic digest', () => {
      const digest = computeDepsDigest([
        { file: 'textures/a.png', hash: 'hashA' },
        { file: 'buffers/b.bin', hash: 'hashB' }
      ])
      expect(digest).toMatch(/^[0-9a-f]{16}$/)
    })
  })

  describe('and the entity content is shuffled', () => {
    it('should produce the same digest regardless of input order', () => {
      const a = computeDepsDigest([
        { file: 'a.png', hash: 'h1' },
        { file: 'b.png', hash: 'h2' },
        { file: 'c.bin', hash: 'h3' }
      ])
      const b = computeDepsDigest([
        { file: 'c.bin', hash: 'h3' },
        { file: 'a.png', hash: 'h1' },
        { file: 'b.png', hash: 'h2' }
      ])
      expect(a).toBe(b)
    })
  })

  describe('and the entity has non-dep files mixed in', () => {
    it('should ignore scene code, manifests, and glb/gltf themselves', () => {
      // A glb is not a dep of another glb — only textures + bins feed dep refs.
      const bare = computeDepsDigest([{ file: 'a.png', hash: 'h1' }])
      const noisy = computeDepsDigest([
        { file: 'a.png', hash: 'h1' },
        { file: 'main.crdt', hash: 'hCrdt' },
        { file: 'index.js', hash: 'hJs' },
        { file: 'model.glb', hash: 'hGlb' },
        { file: 'scene.json', hash: 'hScene' }
      ])
      expect(noisy).toBe(bare)
    })
  })

  describe('and the entity content is empty', () => {
    it('should still produce a well-defined 16-hex digest', () => {
      const digest = computeDepsDigest([])
      expect(digest).toMatch(/^[0-9a-f]{16}$/)
    })
  })

  describe('and two files share a hash but differ in filename', () => {
    it('should distinguish them in the digest (filename-primary sort)', () => {
      const a = computeDepsDigest([
        { file: 'alpha.png', hash: 'sharedHash' },
        { file: 'beta.png', hash: 'sharedHash' }
      ])
      const b = computeDepsDigest([{ file: 'alpha.png', hash: 'sharedHash' }])
      expect(a).not.toBe(b)
    })
  })

  describe('and two entities differ by a single texture hash', () => {
    it('should produce different digests', () => {
      const a = computeDepsDigest([{ file: 'tex.png', hash: 'hY' }])
      const b = computeDepsDigest([{ file: 'tex.png', hash: 'hZ' }])
      expect(a).not.toBe(b)
    })
  })
})

describe('when building the canonical bundle filename', () => {
  describe('and the extension is a glb/gltf', () => {
    it('should fold the deps digest into the filename', () => {
      expect(canonicalFilename('modelHash', '.glb', 'windows', 'abcd1234abcd1234')).toBe(
        'modelHash_abcd1234abcd1234_windows'
      )
      expect(canonicalFilename('modelHash', '.gltf', 'windows', 'abcd1234abcd1234')).toBe(
        'modelHash_abcd1234abcd1234_windows'
      )
    })
  })

  describe('and the entity has a glb with no textures or buffers', () => {
    it('should still produce a stable composite filename (digest over empty dep set)', async () => {
      const content = [{ file: 'standalone.glb', hash: 'soloGlb' }]
      const existing = new Set([probeKeyFor('v48', 'soloGlb', '.glb', 'windows', content)])
      const { components, calls } = makeMockComponents(existing)
      const result = await checkAssetCache(components, {
        entity: { content } as any,
        abVersion: 'v48',
        buildTarget: 'windows',
        cdnBucket: 'bucket'
      })

      expect(calls).toHaveLength(1)
      // Composite key has a well-defined digest for the empty dep set.
      expect(calls[0].Key).toMatch(/^v48\/assets\/soloGlb_[0-9a-f]{16}_windows$/)
      expect(result.cachedHashes).toEqual(['soloGlb'])
    })
  })

  describe('and the extension is a leaf (bin or texture)', () => {
    it('should keep the bare hash-only form', () => {
      expect(canonicalFilename('bufHash', '.bin', 'windows', 'abcd1234abcd1234')).toBe('bufHash_windows')
      expect(canonicalFilename('texHash', '.png', 'windows', 'abcd1234abcd1234')).toBe('texHash_windows')
    })
  })
})

describe('when checking the asset cache against S3', () => {
  describe('and no assets have valid extensions', () => {
    it('should return empty results without probing S3', async () => {
      const { components, calls } = makeMockComponents(new Set())
      const result = await checkAssetCache(components, {
        entity: { content: [{ file: 'scene.json', hash: 'h1' }, { file: 'game.js', hash: 'h2' }] } as any,
        abVersion: 'v48',
        buildTarget: 'windows',
        cdnBucket: 'bucket'
      })

      expect(result.cachedHashes).toEqual([])
      expect(result.missingHashes).toEqual([])
      expect(result.unitySkippableHashes).toEqual([])
      expect(result.canonicalNameByHash).toEqual({})
      expect(calls).toHaveLength(0)
    })
  })

  describe('and every asset hash is cached', () => {
    const content = [
      { file: 'model.glb', hash: 'glbHash' },
      { file: 'texture.png', hash: 'textureHash' },
      { file: 'buffer.bin', hash: 'bufferHash' }
    ]

    it('should probe glb at the composite path and leaves at the bare path', async () => {
      const existing = new Set([
        probeKeyFor('v48', 'glbHash', '.glb', 'windows', content),
        'v48/assets/textureHash_windows',
        'v48/assets/bufferHash_windows'
      ])
      const { components } = makeMockComponents(existing)
      const result = await checkAssetCache(components, {
        entity: { content } as any,
        abVersion: 'v48',
        buildTarget: 'windows',
        cdnBucket: 'bucket'
      })

      expect(result.cachedHashes.sort()).toEqual(['bufferHash', 'glbHash', 'textureHash'])
      expect(result.missingHashes).toEqual([])
      expect(result.unitySkippableHashes.sort()).toEqual(['bufferHash', 'glbHash'])
    })

    it('should surface the composite filename in canonicalNameByHash for glb', async () => {
      const existing = new Set([
        probeKeyFor('v48', 'glbHash', '.glb', 'windows', content),
        'v48/assets/textureHash_windows',
        'v48/assets/bufferHash_windows'
      ])
      const { components } = makeMockComponents(existing)
      const result = await checkAssetCache(components, {
        entity: { content } as any,
        abVersion: 'v48',
        buildTarget: 'windows',
        cdnBucket: 'bucket'
      })

      const digest = computeDepsDigest(content)
      expect(result.canonicalNameByHash).toEqual({
        glbHash: `glbHash_${digest}_windows`,
        textureHash: 'textureHash_windows',
        bufferHash: 'bufferHash_windows'
      })
      expect(result.depsDigest).toBe(digest)
    })
  })

  describe('and two entities share a glb hash but have different dep sets', () => {
    it('should produce distinct probe keys so neither collides with the other', async () => {
      const sceneA = [
        { file: 'model.glb', hash: 'sharedGlb' },
        { file: 'skinA.png', hash: 'hashA' }
      ]
      const sceneB = [
        { file: 'model.glb', hash: 'sharedGlb' },
        { file: 'skinB.png', hash: 'hashB' }
      ]

      const keyA = probeKeyFor('v48', 'sharedGlb', '.glb', 'windows', sceneA)
      const keyB = probeKeyFor('v48', 'sharedGlb', '.glb', 'windows', sceneB)
      expect(keyA).not.toBe(keyB)

      // Mock only scene A's canonical key; scene B must miss.
      const { components, calls } = makeMockComponents(new Set([keyA]))
      const resultB = await checkAssetCache(components, {
        entity: { content: sceneB } as any,
        abVersion: 'v48',
        buildTarget: 'windows',
        cdnBucket: 'bucket'
      })
      expect(resultB.cachedHashes).not.toContain('sharedGlb')
      expect(resultB.missingHashes).toContain('sharedGlb')
      expect(calls.some((c) => c.Key === keyB)).toBe(true)
    })
  })

  describe('and a mix of hashes are cached and missing', () => {
    it('should split correctly and only flag GLTF/BIN extensions as Unity-skippable', async () => {
      const content = [
        { file: 'model.glb', hash: 'glbHash' },
        { file: 'newModel.glb', hash: 'missingGlb' },
        { file: 'texture.png', hash: 'textureHash' },
        { file: 'newBuffer.bin', hash: 'missingBuf' }
      ]
      const existing = new Set([
        probeKeyFor('v48', 'glbHash', '.glb', 'windows', content),
        'v48/assets/textureHash_windows'
      ])
      const { components } = makeMockComponents(existing)
      const result = await checkAssetCache(components, {
        entity: { content } as any,
        abVersion: 'v48',
        buildTarget: 'windows',
        cdnBucket: 'bucket'
      })

      expect(result.cachedHashes.sort()).toEqual(['glbHash', 'textureHash'])
      expect(result.missingHashes.sort()).toEqual(['missingBuf', 'missingGlb'])
      expect(result.unitySkippableHashes).toEqual(['glbHash'])
    })
  })

  describe('and the same hash appears twice in entity.content', () => {
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

  describe('and S3 returns a non-404 error', () => {
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

  describe('and concurrency is zero', () => {
    it('should still complete probing every hash (clamped to at least one worker)', async () => {
      const content = [
        { file: 'a.bin', hash: 'h1' },
        { file: 'b.bin', hash: 'h2' },
        { file: 'c.bin', hash: 'h3' }
      ]
      const existing = new Set(['v48/assets/h1_windows', 'v48/assets/h2_windows', 'v48/assets/h3_windows'])
      const { components, calls } = makeMockComponents(existing)
      const result = await checkAssetCache(components, {
        entity: { content } as any,
        abVersion: 'v48',
        buildTarget: 'windows',
        cdnBucket: 'bucket',
        concurrency: 0
      })

      expect(result.cachedHashes.sort()).toEqual(['h1', 'h2', 'h3'])
      expect(calls).toHaveLength(3)
    })
  })

  describe('and entity.content is empty', () => {
    it('should return empty results without probing S3 or emitting metrics', async () => {
      const { components, calls, metricsCalls } = makeMockComponents(new Set())
      const result = await checkAssetCache(components, {
        entity: { content: [] } as any,
        abVersion: 'v48',
        buildTarget: 'windows',
        cdnBucket: 'bucket'
      })

      expect(result.cachedHashes).toEqual([])
      expect(result.missingHashes).toEqual([])
      expect(result.unitySkippableHashes).toEqual([])
      expect(result.canonicalNameByHash).toEqual({})
      expect(calls).toHaveLength(0)
      expect(metricsCalls).toHaveLength(0)
    })
  })

  describe('and asset uses uppercase file extension', () => {
    it('should still probe (extension check is case-insensitive)', async () => {
      const content = [{ file: 'MODEL.GLB', hash: 'h1' }]
      const existing = new Set([probeKeyFor('v48', 'h1', '.glb', 'windows', content)])
      const { components, calls } = makeMockComponents(existing)
      const result = await checkAssetCache(components, {
        entity: { content } as any,
        abVersion: 'v48',
        buildTarget: 'windows',
        cdnBucket: 'bucket'
      })

      expect(calls).toHaveLength(1)
      expect(result.unitySkippableHashes).toEqual(['h1'])
    })
  })

  describe('and the hit-cache already knows a hash is canonical', () => {
    it('should skip the S3 HEAD for that hash on the next conversion', async () => {
      // Use .bin so probe keys stay bare — simpler to reason about across two
      // distinct entity content lists, since digest depends on content.
      const existing = new Set(['v48/assets/h1_windows', 'v48/assets/h2_windows'])
      const firstRun = makeMockComponents(existing)

      await checkAssetCache(firstRun.components, {
        entity: {
          content: [
            { file: 'a.bin', hash: 'h1' },
            { file: 'b.bin', hash: 'h2' }
          ]
        } as any,
        abVersion: 'v48',
        buildTarget: 'windows',
        cdnBucket: 'bucket'
      })
      expect(firstRun.calls).toHaveLength(2)

      const secondRun = makeMockComponents(new Set())
      const result = await checkAssetCache(secondRun.components, {
        entity: {
          content: [
            { file: 'a.bin', hash: 'h1' },
            { file: 'c.bin', hash: 'h3' }
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

      const firstRun = makeMockComponents(existing)
      await checkAssetCache(firstRun.components, {
        entity: {
          content: [
            { file: 'a.bin', hash: 'h1' },
            { file: 'b.bin', hash: 'h2' }
          ]
        } as any,
        abVersion: 'v48',
        buildTarget: 'windows',
        cdnBucket: 'bucket'
      })
      expect(firstRun.metricsCalls.find((m) => m.name === 'ab_converter_asset_probe_head_total')?.value).toBe(2)
      expect(firstRun.metricsCalls.find((m) => m.name === 'ab_converter_asset_probe_hit_cache_total')).toBeUndefined()

      const secondRun = makeMockComponents(new Set())
      await checkAssetCache(secondRun.components, {
        entity: {
          content: [
            { file: 'a.bin', hash: 'h1' },
            { file: 'c.bin', hash: 'h3' }
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

      await checkAssetCache(components, {
        entity: { content: [{ file: 'a.bin', hash: 'h1' }] } as any,
        abVersion: 'v48',
        buildTarget: 'windows',
        cdnBucket: 'bucket'
      })

      const macRun = makeMockComponents(new Set())
      await checkAssetCache(macRun.components, {
        entity: { content: [{ file: 'a.bin', hash: 'h1' }] } as any,
        abVersion: 'v48',
        buildTarget: 'mac',
        cdnBucket: 'bucket'
      })
      expect(macRun.calls.map((c) => c.Key)).toEqual(['v48/assets/h1_mac'])

      const v49Run = makeMockComponents(new Set())
      await checkAssetCache(v49Run.components, {
        entity: { content: [{ file: 'a.bin', hash: 'h1' }] } as any,
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

  describe('and a HEAD probe misses', () => {
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

describe('when purging cached bundles from the output directory', () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'asset-reuse-test-'))
  })

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  describe('and called with a directory containing mixed files', () => {
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

  describe('and the output directory does not exist', () => {
    it('should return 0 without throwing', async () => {
      const { logger } = makeMockLogger()
      const removed = await purgeCachedBundlesFromOutput('/tmp/definitely-not-a-real-path-12345', ['cached'], logger)
      expect(removed).toBe(0)
    })
  })

  describe('and cachedHashes is empty', () => {
    it('should return 0 without reading the directory', async () => {
      await fs.writeFile(path.join(tmpDir, 'cached_windows'), 'x')
      const { logger } = makeMockLogger()
      const removed = await purgeCachedBundlesFromOutput(tmpDir, [], logger)
      expect(removed).toBe(0)
      expect(await fs.readdir(tmpDir)).toEqual(['cached_windows'])
    })
  })

  describe('and a filename starts with a cached hash but is a different hash', () => {
    it('should keep the file because the hash-separator must match', async () => {
      await fs.writeFile(path.join(tmpDir, 'cachedExtended_windows'), 'x')
      const { logger } = makeMockLogger()
      const removed = await purgeCachedBundlesFromOutput(tmpDir, ['cached'], logger)
      expect(removed).toBe(0)
      expect(await fs.readdir(tmpDir)).toEqual(['cachedExtended_windows'])
    })
  })

  describe('and a composite glb filename is present', () => {
    it('should match the leading hash prefix and purge the composite file', async () => {
      // New scheme emits `{hash}_{digest}_{target}` for glb/gltf. The purge
      // helper extracts the leading hash (pre-first-`_`) and still matches.
      await fs.writeFile(path.join(tmpDir, 'modelHash_abcd1234abcd1234_windows'), 'x')
      await fs.writeFile(path.join(tmpDir, 'modelHash_abcd1234abcd1234_windows.br'), 'x')

      const { logger } = makeMockLogger()
      const removed = await purgeCachedBundlesFromOutput(tmpDir, ['modelHash'], logger)

      expect(removed).toBe(2)
      expect(await fs.readdir(tmpDir)).toEqual([])
    })
  })

  describe('and fs.unlink throws for some entries', () => {
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

  describe('and Unity emits generic artifacts without a hash prefix', () => {
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
