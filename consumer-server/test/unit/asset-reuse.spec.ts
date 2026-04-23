import * as fs from 'fs/promises'
import * as path from 'path'
import * as os from 'os'
import {
  canonicalFilename,
  canonicalFilenameForAsset,
  checkAssetCache,
  computeDepsDigest,
  computePerAssetDigests,
  probeHitCache,
  purgeCachedBundlesFromOutput,
  GltfFetcher
} from '../../src/logic/asset-reuse'
import { buildGlb } from '../helpers/glb-fixtures'

const originalFetch = globalThis.fetch

let mockedFetch: jest.Mock

beforeEach(() => {
  // The hit-cache is process-local and survives across tests unless we clear it.
  probeHitCache.clear()
  mockedFetch = jest.fn()
  globalThis.fetch = mockedFetch as any
})

afterEach(() => {
  globalThis.fetch = originalFetch
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

function makeFetcher(byHash: Map<string, Buffer>): GltfFetcher {
  return async (url: string) => {
    // Caller passes `{contentsBaseUrl}{hash}` — we only care about the hash.
    const hash = url.split('/').pop()!
    const buf = byHash.get(hash)
    if (!buf) throw new Error(`no fixture for hash ${hash}`)
    return buf
  }
}

// Shorthand to compute the canonical S3 key a probe would HEAD for a single
// hash given a pre-computed per-asset digest map. Mirrors the production
// call-path exactly (`canonicalFilenameForAsset` → `${prefix}/assets/${name}`).
function probeKeyFor(abVersion: string, hash: string, ext: string, target: string, digests: Map<string, string>) {
  return `${abVersion}/assets/${canonicalFilenameForAsset(hash, ext, target, digests)}`
}

function arrayBufferFor(buf: Buffer): ArrayBuffer {
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)
}

function streamFromChunks(
  chunks: Buffer[],
  options: { cancel?: jest.Mock; errorAtIndex?: number } = {}
): ReadableStream<Uint8Array> {
  let index = 0
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (options.errorAtIndex === index) throw new Error('socket hang up')
      if (index >= chunks.length) {
        controller.close()
        return
      }
      controller.enqueue(chunks[index++])
    },
    cancel: options.cancel
  })
}

function responseForChunks(
  chunks: Buffer[],
  options: { status?: number; body?: ReadableStream<Uint8Array> | null; contentLength?: number } = {}
): any {
  const status = options.status ?? 200
  const buf = Buffer.concat(chunks)
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : 'ERR',
    headers: {
      get: (name: string) =>
        name.toLowerCase() === 'content-length' ? String(options.contentLength ?? buf.length) : null
    },
    body: options.body === undefined ? streamFromChunks(chunks) : options.body,
    arrayBuffer: async () => arrayBufferFor(buf)
  }
}

function responseWithoutBody(buf: Buffer): any {
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    headers: {
      get: (name: string) => (name.toLowerCase() === 'content-length' ? String(buf.length) : null)
    },
    arrayBuffer: async () => arrayBufferFor(buf)
  }
}

function entityWithGlb(hash = 'hGlb') {
  return {
    content: [
      { file: 'model.glb', hash },
      { file: 'texture.png', hash: 'hTexture' }
    ]
  }
}

describe('when computing the deps digest', () => {
  describe('and the entity has only textures and buffers', () => {
    it('should return a 32-hex deterministic digest', () => {
      const digest = computeDepsDigest([
        { file: 'textures/a.png', hash: 'hashA' },
        { file: 'buffers/b.bin', hash: 'hashB' }
      ])
      expect(digest).toMatch(/^[0-9a-f]{32}$/)
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
    it('should still produce a well-defined 32-hex digest', () => {
      const digest = computeDepsDigest([])
      expect(digest).toMatch(/^[0-9a-f]{32}$/)
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

  describe('and a content entry has no file extension at all', () => {
    it('should ignore it (not a leaf-dep kind)', () => {
      const withBareName = computeDepsDigest([
        { file: 'tex.png', hash: 'hA' },
        { file: 'weird-file-no-extension', hash: 'hB' }
      ])
      const withoutBareName = computeDepsDigest([{ file: 'tex.png', hash: 'hA' }])
      expect(withBareName).toBe(withoutBareName)
    })
  })

  describe('and a filename contains tab or newline characters', () => {
    it('should produce different digests for differently-placed separators', () => {
      // Regression guard on the JSON-stringify encoding: a bare
      // `${file}\t${hash}\n` concat would collapse these two into the same
      // digest by accident. The JSON encoding keeps them distinct.
      const a = computeDepsDigest([
        { file: 'a\tb.png', hash: 'h1' },
        { file: 'c.png', hash: 'h2' }
      ])
      const b = computeDepsDigest([
        { file: 'a', hash: 'b.png\th1' },
        { file: 'c.png', hash: 'h2' }
      ])
      expect(a).not.toBe(b)
    })
  })
})

// Cross-language golden-vector contract. The Unity converter computes its own
// digest in C# and receives Node's via `-depsDigestsFile`. If the two drift
// (sort order, separator, truncation, SHA variant, extension filter), bundles
// land at paths the probe never hits — or worse, at paths that collide with
// unrelated assets. The fixture at test/fixtures/deps-digest-vectors.json is
// the single source of truth; both this test and the Unity-side EditMode test
// read from it.
describe('when computing deps digests against the cross-language golden vectors', () => {
  const fixturePath = path.join(__dirname, '..', 'fixtures', 'deps-digest-vectors.json')
  const fixture = JSON.parse(require('fs').readFileSync(fixturePath, 'utf8')) as {
    vectors: Array<{ name: string; input: Array<{ file: string; hash: string }>; expected: string }>
  }

  describe.each(fixture.vectors)('and the vector is "$name"', ({ input, expected }) => {
    it('should produce the fixture-recorded digest byte-for-byte', () => {
      expect(computeDepsDigest(input)).toBe(expected)
    })
  })

  describe('and two vectors share the same content in different orders', () => {
    it('should produce identical digests (sort is content-defined, input-order-independent)', () => {
      const sorted = fixture.vectors.find((v) => v.name === 'two_textures_sorted')!
      const shuffled = fixture.vectors.find((v) => v.name === 'two_textures_shuffled_same_content')!
      expect(sorted.expected).toBe(shuffled.expected)
    })
  })

  describe('and every fixture digest is inspected', () => {
    it('should be 32 lowercase hex chars (128-bit truncation, stable across implementations)', () => {
      for (const v of fixture.vectors) {
        expect(v.expected).toMatch(/^[0-9a-f]{32}$/)
      }
    })
  })
})

describe('when computing per-asset digests', () => {
  describe('and two glbs reference disjoint dep sets', () => {
    let digests: Map<string, string>

    beforeEach(async () => {
      const entity = {
        content: [
          { file: 'a.glb', hash: 'hA' },
          { file: 'b.glb', hash: 'hB' },
          { file: 'x.png', hash: 'hX' },
          { file: 'y.png', hash: 'hY' }
        ]
      }
      const fetcher = makeFetcher(
        new Map([
          ['hA', buildGlb(['x.png'])],
          ['hB', buildGlb(['y.png'])]
        ])
      )
      digests = await computePerAssetDigests(entity, 'https://peer.decentraland.org/content', { fetcher })
    })

    it('should assign each glb a distinct digest', () => {
      expect(digests.get('hA')).not.toBe(digests.get('hB'))
    })
  })

  describe('and two glbs reference the same deps in reverse JSON order', () => {
    let digests: Map<string, string>

    beforeEach(async () => {
      const entity = {
        content: [
          { file: 'a.glb', hash: 'hA' },
          { file: 'b.glb', hash: 'hB' },
          { file: 'x.png', hash: 'hX' },
          { file: 'y.png', hash: 'hY' }
        ]
      }
      const fetcher = makeFetcher(
        new Map([
          ['hA', buildGlb(['x.png', 'y.png'])],
          ['hB', buildGlb(['y.png', 'x.png'])]
        ])
      )
      digests = await computePerAssetDigests(entity, 'https://peer.decentraland.org/content', { fetcher })
    })

    it('should produce identical digests (order-invariance)', () => {
      expect(digests.get('hA')).toBe(digests.get('hB'))
    })
  })

  describe('and one glb references the same texture twice while the other references it once', () => {
    let digests: Map<string, string>

    beforeEach(async () => {
      const entity = {
        content: [
          { file: 'a.glb', hash: 'hA' },
          { file: 'b.glb', hash: 'hB' },
          { file: 'x.png', hash: 'hX' }
        ]
      }
      const fetcher = makeFetcher(
        new Map([
          ['hA', buildGlb(['x.png', 'x.png'])],
          ['hB', buildGlb(['x.png'])]
        ])
      )
      digests = await computePerAssetDigests(entity, 'https://peer.decentraland.org/content', { fetcher })
    })

    it('should produce identical digests (dedup-invariance)', () => {
      expect(digests.get('hA')).toBe(digests.get('hB'))
    })
  })

  describe('and a glb references a file that is not in the entity content', () => {
    it('should reject the whole computation', async () => {
      const entity = {
        content: [{ file: 'a.glb', hash: 'hA' }]
      }
      const fetcher = makeFetcher(new Map([['hA', buildGlb(['missing.png'])]]))
      await expect(
        computePerAssetDigests(entity, 'https://peer.decentraland.org/content', { fetcher })
      ).rejects.toThrow(/not in the entity content/)
    })
  })

  describe('and a glb dep subset differs from the entity-wide dep set', () => {
    let perAssetDigest: string
    let entityWideDigest: string

    beforeEach(async () => {
      const entityContent = [
        { file: 'a.glb', hash: 'hA' },
        { file: 'x.png', hash: 'hX' },
        { file: 'unused.png', hash: 'hUnused' }
      ]
      const fetcher = makeFetcher(new Map([['hA', buildGlb(['x.png'])]]))
      const digests = await computePerAssetDigests(
        { content: entityContent },
        'https://peer.decentraland.org/content',
        { fetcher }
      )
      perAssetDigest = digests.get('hA')!
      entityWideDigest = computeDepsDigest(entityContent)
    })

    it('should narrow the glb digest to its referenced subset, diverging from the entity-wide digest', () => {
      expect(perAssetDigest).not.toBe(entityWideDigest)
    })
  })

  describe('and the entity has no glb/gltf entries', () => {
    it('should return an empty map without making any fetches', async () => {
      const calls: string[] = []
      const fetcher: GltfFetcher = async (url) => {
        calls.push(url)
        return Buffer.alloc(0)
      }
      const digests = await computePerAssetDigests(
        { content: [{ file: 'tex.png', hash: 'hX' }] },
        'https://peer.decentraland.org/content',
        { fetcher }
      )
      expect(digests.size).toBe(0)
      expect(calls).toEqual([])
    })
  })

  describe('and the glb sits in a subdirectory with a relative texture URI', () => {
    let digests: Map<string, string>

    beforeEach(async () => {
      const entity = {
        content: [
          { file: 'models/car.glb', hash: 'hCar' },
          { file: 'textures/paint.png', hash: 'hPaint' }
        ]
      }
      const fetcher = makeFetcher(new Map([['hCar', buildGlb(['../textures/paint.png'])]]))
      digests = await computePerAssetDigests(entity, 'https://peer.decentraland.org/content', { fetcher })
    })

    it('should resolve the relative URI against the glb location and record the digest', () => {
      expect(digests.get('hCar')).toMatch(/^[0-9a-f]{32}$/)
    })
  })
})

describe('when computing per-asset digests with the default gltf fetcher', () => {
  describe('and a glb has a large BIN payload after the JSON chunk', () => {
    let digests: Map<string, string>
    let cancel: jest.Mock

    beforeEach(async () => {
      const glb = buildGlb(['texture.png'])
      cancel = jest.fn()
      const body = streamFromChunks(
        [glb.subarray(0, 7), glb.subarray(7, 20), glb.subarray(20), Buffer.alloc(5 * 1024)],
        { cancel }
      )
      mockedFetch.mockResolvedValue(responseForChunks([glb, Buffer.alloc(5 * 1024)], { body }))

      digests = await computePerAssetDigests(entityWithGlb(), 'https://peer.decentraland.org/content')
    })

    it('should read enough bytes to compute the digest', () => {
      expect(digests.get('hGlb')).toMatch(/^[0-9a-f]{32}$/)
    })

    it('should cancel the stream after the GLB JSON chunk is complete', () => {
      expect(cancel).toHaveBeenCalled()
    })
  })

  describe('and a stream ends before the GLB JSON header is complete', () => {
    let thrown: unknown

    beforeEach(async () => {
      const glb = buildGlb(['texture.png'])
      mockedFetch.mockResolvedValue(responseForChunks([glb.subarray(0, 10)]))
      try {
        await computePerAssetDigests(entityWithGlb(), 'https://peer.decentraland.org/content')
      } catch (err: unknown) {
        thrown = err
      }
    })

    it('should reject without retrying', () => {
      expect(thrown).toBeInstanceOf(Error)
      expect((thrown as Error).message).toMatch(/ended before the 20-byte GLB JSON header/)
      expect(mockedFetch).toHaveBeenCalledTimes(1)
    })
  })

  describe('and a stream ends before the declared GLB JSON chunk is complete', () => {
    let thrown: unknown

    beforeEach(async () => {
      const glb = buildGlb(['texture.png'])
      mockedFetch.mockResolvedValue(responseForChunks([glb.subarray(0, 24)]))
      try {
        await computePerAssetDigests(entityWithGlb(), 'https://peer.decentraland.org/content')
      } catch (err: unknown) {
        thrown = err
      }
    })

    it('should reject without retrying', () => {
      expect(thrown).toBeInstanceOf(Error)
      expect((thrown as Error).message).toMatch(/before JSON chunk end/)
      expect(mockedFetch).toHaveBeenCalledTimes(1)
    })
  })

  describe('and a stream errors before the GLB JSON chunk is complete but a retry succeeds', () => {
    let digests: Map<string, string>
    let cancel: jest.Mock

    beforeEach(async () => {
      const glb = buildGlb(['texture.png'])
      cancel = jest.fn()
      const read = jest
        .fn()
        .mockResolvedValueOnce({ done: false, value: glb.subarray(0, 10) })
        .mockRejectedValueOnce(new Error('socket hang up'))
      const failingBody = {
        getReader: () => ({
          read,
          cancel,
          releaseLock: jest.fn()
        })
      } as any
      mockedFetch
        .mockResolvedValueOnce(responseForChunks([glb.subarray(0, 10)], { body: failingBody }))
        .mockResolvedValueOnce(responseForChunks([glb]))

      digests = await computePerAssetDigests(entityWithGlb(), 'https://peer.decentraland.org/content')
    })

    it('should retry and compute the digest from the next response', () => {
      expect(digests.get('hGlb')).toMatch(/^[0-9a-f]{32}$/)
    })

    it('should cancel the failed stream', () => {
      expect(cancel).toHaveBeenCalled()
    })
  })

  describe('and native fetch returns a response without a body stream', () => {
    let digests: Map<string, string>

    beforeEach(async () => {
      const glb = buildGlb(['texture.png'])
      mockedFetch.mockResolvedValue(responseWithoutBody(glb))

      digests = await computePerAssetDigests(entityWithGlb(), 'https://peer.decentraland.org/content')
    })

    it('should fall back to guarded arrayBuffer reads', () => {
      expect(digests.get('hGlb')).toMatch(/^[0-9a-f]{32}$/)
    })
  })

  describe('and a transient HTTP status is followed by a successful response', () => {
    let digests: Map<string, string>

    beforeEach(async () => {
      const glb = buildGlb(['texture.png'])
      mockedFetch.mockResolvedValueOnce(responseForChunks([Buffer.from('busy')], { status: 503 }))
      mockedFetch.mockResolvedValueOnce(responseForChunks([glb]))

      digests = await computePerAssetDigests(entityWithGlb(), 'https://peer.decentraland.org/content')
    })

    it('should retry and compute the digest', () => {
      expect(digests.get('hGlb')).toMatch(/^[0-9a-f]{32}$/)
    })
  })

  describe('and a non-retryable HTTP status is returned', () => {
    let thrown: unknown

    beforeEach(async () => {
      mockedFetch.mockResolvedValue(responseForChunks([Buffer.from('missing')], { status: 404 }))
      try {
        await computePerAssetDigests(entityWithGlb(), 'https://peer.decentraland.org/content')
      } catch (err: unknown) {
        thrown = err
      }
    })

    it('should reject without retrying', () => {
      expect(thrown).toBeInstanceOf(Error)
      expect((thrown as Error).message).toMatch(/failed to fetch/)
      expect(mockedFetch).toHaveBeenCalledTimes(1)
    })
  })

  describe('and the GLB header declares an oversized JSON chunk', () => {
    let thrown: unknown

    beforeEach(async () => {
      const header = Buffer.alloc(20)
      header.writeUInt32LE(256 * 1024 * 1024 + 1, 12)
      mockedFetch.mockResolvedValue(responseForChunks([header]))
      try {
        await computePerAssetDigests(entityWithGlb(), 'https://peer.decentraland.org/content')
      } catch (err: unknown) {
        thrown = err
      }
    })

    it('should reject without retrying', () => {
      expect(thrown).toBeInstanceOf(Error)
      expect((thrown as Error).message).toMatch(/JSON chunk/)
      expect(mockedFetch).toHaveBeenCalledTimes(1)
    })
  })

  describe('and the streamed GLB is malformed but complete enough to parse', () => {
    let thrown: unknown

    beforeEach(async () => {
      const malformed = Buffer.alloc(20)
      mockedFetch.mockResolvedValue(responseForChunks([malformed]))
      try {
        await computePerAssetDigests(entityWithGlb(), 'https://peer.decentraland.org/content')
      } catch (err: unknown) {
        thrown = err
      }
    })

    it('should reject without retrying parse failures', () => {
      expect(thrown).toBeInstanceOf(Error)
      expect((thrown as Error).message).toMatch(/magic mismatch/)
      expect(mockedFetch).toHaveBeenCalledTimes(1)
    })
  })

  describe('and the asset is a text gltf', () => {
    let digests: Map<string, string>

    beforeEach(async () => {
      const gltf = Buffer.from(JSON.stringify({ images: [{ uri: 'texture.png' }] }), 'utf8')
      const entity = {
        content: [
          { file: 'model.gltf', hash: 'hGltf' },
          { file: 'texture.png', hash: 'hTexture' }
        ]
      }
      mockedFetch.mockResolvedValue(responseForChunks([gltf.subarray(0, 8), gltf.subarray(8)]))

      digests = await computePerAssetDigests(entity, 'https://peer.decentraland.org/content')
    })

    it('should stream the full JSON document and compute the digest', () => {
      expect(digests.get('hGltf')).toMatch(/^[0-9a-f]{32}$/)
    })
  })
})

describe('when building the canonical bundle filename (legacy entity-wide variant)', () => {
  describe('and the extension is a glb/gltf', () => {
    it('should fold the deps digest into the filename', () => {
      const digest = 'abcd1234abcd1234abcd1234abcd1234'
      expect(canonicalFilename('modelHash', '.glb', 'windows', digest)).toBe(`modelHash_${digest}_windows`)
      expect(canonicalFilename('modelHash', '.gltf', 'windows', digest)).toBe(`modelHash_${digest}_windows`)
    })
  })

  describe('and the extension is a leaf (bin or texture)', () => {
    it('should keep the bare hash-only form', () => {
      const digest = 'abcd1234abcd1234abcd1234abcd1234'
      expect(canonicalFilename('bufHash', '.bin', 'windows', digest)).toBe('bufHash_windows')
      expect(canonicalFilename('texHash', '.png', 'windows', digest)).toBe('texHash_windows')
    })
  })
})

describe('when building the canonical bundle filename per-asset', () => {
  describe('and the extension is a glb/gltf with a digest present in the map', () => {
    it('should fold the per-asset digest into the filename', () => {
      const digests = new Map([['modelHash', 'abcd1234abcd1234abcd1234abcd1234']])
      expect(canonicalFilenameForAsset('modelHash', '.glb', 'windows', digests)).toBe(
        'modelHash_abcd1234abcd1234abcd1234abcd1234_windows'
      )
    })
  })

  describe('and a glb hash has no entry in the map', () => {
    it('should throw rather than silently emit a bare filename', () => {
      expect(() => canonicalFilenameForAsset('unknownHash', '.glb', 'windows', new Map())).toThrow(
        /missing per-asset deps digest/
      )
    })
  })

  describe('and the extension is a leaf (bin or texture)', () => {
    it('should keep the bare hash-only form regardless of map contents', () => {
      const digests = new Map([['whatever', 'abcd']])
      expect(canonicalFilenameForAsset('bufHash', '.bin', 'windows', digests)).toBe('bufHash_windows')
      expect(canonicalFilenameForAsset('texHash', '.png', 'windows', digests)).toBe('texHash_windows')
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
        cdnBucket: 'bucket',
        depsDigestByHash: new Map()
      })

      expect(result.cachedHashes).toEqual([])
      expect(result.missingHashes).toEqual([])
      expect(result.unitySkippableHashes).toEqual([])
      expect(result.canonicalNameByHash).toEqual({})
      expect(calls).toHaveLength(0)
    })
  })

  describe('and every probeable asset hash is cached', () => {
    // Note: `.bin` is NOT probed (Unity inlines buffers into the referencing
    // GLTF's bundle rather than producing a standalone `{hash}_{target}`), so
    // the `.bin` entry below must not appear in the cache result.
    const content = [
      { file: 'model.glb', hash: 'glbHash' },
      { file: 'texture.png', hash: 'textureHash' },
      { file: 'buffer.bin', hash: 'bufferHash' }
    ]
    const glbDigest = computeDepsDigest([{ file: 'texture.png', hash: 'textureHash' }])
    const depsDigestByHash = new Map([['glbHash', glbDigest]])

    it('should probe glb at the composite path and textures at the bare path, ignoring the .bin', async () => {
      const existing = new Set([
        probeKeyFor('v48', 'glbHash', '.glb', 'windows', depsDigestByHash),
        'v48/assets/textureHash_windows'
      ])
      const { components, calls } = makeMockComponents(existing)
      const result = await checkAssetCache(components, {
        entity: { content } as any,
        abVersion: 'v48',
        buildTarget: 'windows',
        cdnBucket: 'bucket',
        depsDigestByHash
      })

      expect(result.cachedHashes.sort()).toEqual(['glbHash', 'textureHash'])
      expect(result.missingHashes).toEqual([])
      expect(result.unitySkippableHashes).toEqual(['glbHash'])
      // One HEAD per glb + one per texture. The `.bin` is never probed.
      expect(calls).toHaveLength(2)
      expect(calls.every((c) => !c.Key.includes('bufferHash'))).toBe(true)
    })

    it('should surface the composite filename in canonicalNameByHash for glb but omit the .bin', async () => {
      const existing = new Set([
        probeKeyFor('v48', 'glbHash', '.glb', 'windows', depsDigestByHash),
        'v48/assets/textureHash_windows'
      ])
      const { components } = makeMockComponents(existing)
      const result = await checkAssetCache(components, {
        entity: { content } as any,
        abVersion: 'v48',
        buildTarget: 'windows',
        cdnBucket: 'bucket',
        depsDigestByHash
      })

      expect(result.canonicalNameByHash).toEqual({
        glbHash: `glbHash_${glbDigest}_windows`,
        textureHash: 'textureHash_windows'
      })
      expect(result.depsDigestByHash).toBe(depsDigestByHash)
    })
  })

  describe('and two entities share a glb CID but its URI resolves to different texture hashes', () => {
    it('should produce distinct probe keys so neither collides with the other', async () => {
      // Both scenes reference the same glb CID (`sharedGlb`) and that glb has a
      // `skin.png` URI; but scene A maps `skin.png → hashA` while scene B maps
      // `skin.png → hashB`. Per-asset digest captures this divergence.
      const sceneAContent = [
        { file: 'model.glb', hash: 'sharedGlb' },
        { file: 'skin.png', hash: 'hashA' }
      ]
      const sceneBContent = [
        { file: 'model.glb', hash: 'sharedGlb' },
        { file: 'skin.png', hash: 'hashB' }
      ]
      const glbBytes = buildGlb(['skin.png'])
      const fetcher = makeFetcher(new Map([['sharedGlb', glbBytes]]))

      const digestsA = await computePerAssetDigests(
        { content: sceneAContent },
        'https://peer.decentraland.org/content',
        { fetcher }
      )
      const digestsB = await computePerAssetDigests(
        { content: sceneBContent },
        'https://peer.decentraland.org/content',
        { fetcher }
      )

      const keyA = probeKeyFor('v48', 'sharedGlb', '.glb', 'windows', digestsA)
      const keyB = probeKeyFor('v48', 'sharedGlb', '.glb', 'windows', digestsB)
      expect(keyA).not.toBe(keyB)

      // Mock only scene A's canonical key; scene B must miss.
      const { components, calls } = makeMockComponents(new Set([keyA]))
      const resultB = await checkAssetCache(components, {
        entity: { content: sceneBContent } as any,
        abVersion: 'v48',
        buildTarget: 'windows',
        cdnBucket: 'bucket',
        depsDigestByHash: digestsB
      })
      expect(resultB.cachedHashes).not.toContain('sharedGlb')
      expect(resultB.missingHashes).toContain('sharedGlb')
      expect(calls.some((c) => c.Key === keyB)).toBe(true)
    })
  })

  describe('and two scenes share a glb CID AND the same resolved texture hashes', () => {
    it('should produce identical probe keys (cross-scene reuse)', async () => {
      // This is the cross-scene reuse scenario that motivates per-asset digest.
      // Before PR (entity-wide), these two scenes would have landed at different
      // canonical paths as soon as their content lists differed in anything
      // else — here, a different sibling texture that neither glb references.
      const glbBytes = buildGlb(['skin.png'])
      const sceneA = [
        { file: 'model.glb', hash: 'sharedGlb' },
        { file: 'skin.png', hash: 'hSkin' },
        { file: 'other.png', hash: 'hOtherA' } // only in scene A
      ]
      const sceneB = [
        { file: 'model.glb', hash: 'sharedGlb' },
        { file: 'skin.png', hash: 'hSkin' },
        { file: 'extra.png', hash: 'hExtraB' } // only in scene B
      ]
      const fetcher = makeFetcher(new Map([['sharedGlb', glbBytes]]))

      const digestsA = await computePerAssetDigests({ content: sceneA }, 'https://peer.decentraland.org/content', {
        fetcher
      })
      const digestsB = await computePerAssetDigests({ content: sceneB }, 'https://peer.decentraland.org/content', {
        fetcher
      })

      expect(digestsA.get('sharedGlb')).toBe(digestsB.get('sharedGlb'))
      expect(probeKeyFor('v48', 'sharedGlb', '.glb', 'windows', digestsA)).toBe(
        probeKeyFor('v48', 'sharedGlb', '.glb', 'windows', digestsB)
      )
    })
  })

  describe('and a mix of hashes are cached and missing', () => {
    it('should split correctly and only flag GLTF extensions as Unity-skippable', async () => {
      const content = [
        { file: 'model.glb', hash: 'glbHash' },
        { file: 'newModel.glb', hash: 'missingGlb' },
        { file: 'texture.png', hash: 'textureHash' },
        { file: 'newTex.png', hash: 'missingTex' },
        { file: 'newBuffer.bin', hash: 'ignoredBuf' }
      ]
      const digest1 = computeDepsDigest([{ file: 'texture.png', hash: 'textureHash' }])
      const digest2 = computeDepsDigest([{ file: 'newTex.png', hash: 'missingTex' }])
      const depsDigestByHash = new Map([
        ['glbHash', digest1],
        ['missingGlb', digest2]
      ])
      const existing = new Set([
        probeKeyFor('v48', 'glbHash', '.glb', 'windows', depsDigestByHash),
        'v48/assets/textureHash_windows'
      ])
      const { components } = makeMockComponents(existing)
      const result = await checkAssetCache(components, {
        entity: { content } as any,
        abVersion: 'v48',
        buildTarget: 'windows',
        cdnBucket: 'bucket',
        depsDigestByHash
      })

      expect(result.cachedHashes.sort()).toEqual(['glbHash', 'textureHash'])
      expect(result.missingHashes.sort()).toEqual(['missingGlb', 'missingTex'])
      expect(result.unitySkippableHashes).toEqual(['glbHash'])
      expect(result.canonicalNameByHash).not.toHaveProperty('ignoredBuf')
    })
  })

  describe('and the same hash appears twice in entity.content', () => {
    it('should probe it only once', async () => {
      const digest = computeDepsDigest([])
      const depsDigestByHash = new Map([['sameHash', digest]])
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
        cdnBucket: 'bucket',
        depsDigestByHash
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
          cdnBucket: 'bucket',
          depsDigestByHash: new Map([['h', computeDepsDigest([])]])
        })
      ).rejects.toThrow('boom')
    })
  })

  describe('and concurrency is zero', () => {
    it('should still complete probing every hash (clamped to at least one worker)', async () => {
      const content = [
        { file: 'a.png', hash: 'h1' },
        { file: 'b.png', hash: 'h2' },
        { file: 'c.png', hash: 'h3' }
      ]
      const existing = new Set(['v48/assets/h1_windows', 'v48/assets/h2_windows', 'v48/assets/h3_windows'])
      const { components, calls } = makeMockComponents(existing)
      const result = await checkAssetCache(components, {
        entity: { content } as any,
        abVersion: 'v48',
        buildTarget: 'windows',
        cdnBucket: 'bucket',
        concurrency: 0,
        depsDigestByHash: new Map()
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
        cdnBucket: 'bucket',
        depsDigestByHash: new Map()
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
      const depsDigestByHash = new Map([['h1', computeDepsDigest([])]])
      const existing = new Set([probeKeyFor('v48', 'h1', '.glb', 'windows', depsDigestByHash)])
      const { components, calls } = makeMockComponents(existing)
      const result = await checkAssetCache(components, {
        entity: { content } as any,
        abVersion: 'v48',
        buildTarget: 'windows',
        cdnBucket: 'bucket',
        depsDigestByHash
      })

      expect(calls).toHaveLength(1)
      expect(result.unitySkippableHashes).toEqual(['h1'])
    })
  })

  describe('and depsDigestByHash is not supplied but contentServerUrl is', () => {
    it('should compute digests internally via the default flow', async () => {
      const content = [
        { file: 'model.glb', hash: 'glbHash' },
        { file: 'tex.png', hash: 'texHash' }
      ]
      const fetcher = makeFetcher(new Map([['glbHash', buildGlb(['tex.png'])]]))
      const { components, calls } = makeMockComponents(new Set())
      const result = await checkAssetCache(components, {
        entity: { content } as any,
        abVersion: 'v48',
        buildTarget: 'windows',
        cdnBucket: 'bucket',
        contentServerUrl: 'https://peer.decentraland.org/content',
        fetcher
      })

      // Digest was computed internally. The glb was probed at a composite path,
      // the texture at its bare path. Neither hit; both are missing.
      expect(result.missingHashes.sort()).toEqual(['glbHash', 'texHash'])
      expect(calls).toHaveLength(2)
      expect(result.depsDigestByHash.get('glbHash')).toMatch(/^[0-9a-f]{32}$/)
    })
  })

  describe('and neither depsDigestByHash nor contentServerUrl is supplied', () => {
    it('should throw a clear error', async () => {
      const { components } = makeMockComponents(new Set())
      await expect(
        checkAssetCache(components, {
          entity: { content: [{ file: 'a.glb', hash: 'h' }] } as any,
          abVersion: 'v48',
          buildTarget: 'windows',
          cdnBucket: 'bucket'
        })
      ).rejects.toThrow(/depsDigestByHash or contentServerUrl must be supplied/)
    })
  })

  describe('and the hit-cache already knows a hash is canonical', () => {
    it('should skip the S3 HEAD for that hash on the next conversion', async () => {
      const existing = new Set(['v48/assets/h1_windows', 'v48/assets/h2_windows'])
      const firstRun = makeMockComponents(existing)

      await checkAssetCache(firstRun.components, {
        entity: {
          content: [
            { file: 'a.png', hash: 'h1' },
            { file: 'b.png', hash: 'h2' }
          ]
        } as any,
        abVersion: 'v48',
        buildTarget: 'windows',
        cdnBucket: 'bucket',
        depsDigestByHash: new Map()
      })
      expect(firstRun.calls).toHaveLength(2)

      const secondRun = makeMockComponents(new Set())
      const result = await checkAssetCache(secondRun.components, {
        entity: {
          content: [
            { file: 'a.png', hash: 'h1' },
            { file: 'c.png', hash: 'h3' }
          ]
        } as any,
        abVersion: 'v48',
        buildTarget: 'windows',
        cdnBucket: 'bucket',
        depsDigestByHash: new Map()
      })

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
            { file: 'a.png', hash: 'h1' },
            { file: 'b.png', hash: 'h2' }
          ]
        } as any,
        abVersion: 'v48',
        buildTarget: 'windows',
        cdnBucket: 'bucket',
        depsDigestByHash: new Map()
      })
      expect(firstRun.metricsCalls.find((m) => m.name === 'ab_converter_asset_probe_head_total')?.value).toBe(2)
      expect(firstRun.metricsCalls.find((m) => m.name === 'ab_converter_asset_probe_hit_cache_total')).toBeUndefined()

      const secondRun = makeMockComponents(new Set())
      await checkAssetCache(secondRun.components, {
        entity: {
          content: [
            { file: 'a.png', hash: 'h1' },
            { file: 'c.png', hash: 'h3' }
          ]
        } as any,
        abVersion: 'v48',
        buildTarget: 'windows',
        cdnBucket: 'bucket',
        depsDigestByHash: new Map()
      })
      expect(secondRun.metricsCalls.find((m) => m.name === 'ab_converter_asset_probe_hit_cache_total')?.value).toBe(1)
      expect(secondRun.metricsCalls.find((m) => m.name === 'ab_converter_asset_probe_head_total')?.value).toBe(1)
    })

    it('should not confuse hashes across build targets or AB versions', async () => {
      const existing = new Set(['v48/assets/h1_windows'])
      const { components } = makeMockComponents(existing)

      await checkAssetCache(components, {
        entity: { content: [{ file: 'a.png', hash: 'h1' }] } as any,
        abVersion: 'v48',
        buildTarget: 'windows',
        cdnBucket: 'bucket',
        depsDigestByHash: new Map()
      })

      const macRun = makeMockComponents(new Set())
      await checkAssetCache(macRun.components, {
        entity: { content: [{ file: 'a.png', hash: 'h1' }] } as any,
        abVersion: 'v48',
        buildTarget: 'mac',
        cdnBucket: 'bucket',
        depsDigestByHash: new Map()
      })
      expect(macRun.calls.map((c) => c.Key)).toEqual(['v48/assets/h1_mac'])

      const v49Run = makeMockComponents(new Set())
      await checkAssetCache(v49Run.components, {
        entity: { content: [{ file: 'a.png', hash: 'h1' }] } as any,
        abVersion: 'v49',
        buildTarget: 'windows',
        cdnBucket: 'bucket',
        depsDigestByHash: new Map()
      })
      expect(v49Run.calls.map((c) => c.Key)).toEqual(['v49/assets/h1_windows'])
    })

    it('should keep working when methods are called without the object receiver', () => {
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
        probeHitCache.add('k4')

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
        expect(probeHitCache.has('k1')).toBe(true)
        probeHitCache.add('k4')

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
        probeHitCache.add('k1')
        probeHitCache.add('k4')

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
      const digest = computeDepsDigest([])
      const depsDigestByHash = new Map([['h1', digest]])
      const { components, calls } = makeMockComponents(new Set())
      await checkAssetCache(components, {
        entity: { content: [{ file: 'a.glb', hash: 'h1' }] } as any,
        abVersion: 'v48',
        buildTarget: 'windows',
        cdnBucket: 'bucket',
        depsDigestByHash
      })
      expect(calls).toHaveLength(1)
      await checkAssetCache(components, {
        entity: { content: [{ file: 'a.glb', hash: 'h1' }] } as any,
        abVersion: 'v48',
        buildTarget: 'windows',
        cdnBucket: 'bucket',
        depsDigestByHash
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
      await fs.writeFile(path.join(tmpDir, 'modelHash_abcd1234abcd1234abcd1234abcd1234_windows'), 'x')
      await fs.writeFile(path.join(tmpDir, 'modelHash_abcd1234abcd1234abcd1234abcd1234_windows.br'), 'x')

      const { logger } = makeMockLogger()
      const removed = await purgeCachedBundlesFromOutput(tmpDir, ['modelHash'], logger)

      expect(removed).toBe(2)
      expect(await fs.readdir(tmpDir)).toEqual([])
    })
  })

  describe('and fs.unlink throws for some entries', () => {
    it('should log a warning and count only the successful unlinks', async () => {
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
      await fs.writeFile(path.join(tmpDir, 'AssetBundles'), 'x')
      await fs.writeFile(path.join(tmpDir, 'AssetBundles.manifest'), 'x')

      const { logger } = makeMockLogger()
      const removed = await purgeCachedBundlesFromOutput(tmpDir, ['AssetBundles'], logger)

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
