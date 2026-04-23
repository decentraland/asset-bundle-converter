import { parseGltfDepRefs, resolveUriToContentFile } from '../../src/logic/gltf-deps'

function buildGlb(jsonBody: string): Buffer {
  // Minimal valid glTF 2.0 binary: 12-byte header + JSON chunk header + JSON payload.
  // No BIN chunk — the parser doesn't need it. Chunk length must be 4-byte aligned
  // per the spec, but our parser doesn't enforce that because real-world glbs sometimes
  // skip the padding and Unity tolerates it.
  const jsonBytes = Buffer.from(jsonBody, 'utf8')
  const chunkLength = jsonBytes.length
  const total = 12 + 8 + chunkLength
  const buf = Buffer.alloc(total)
  buf.writeUInt32LE(0x46546c67, 0) // "glTF"
  buf.writeUInt32LE(2, 4) // version
  buf.writeUInt32LE(total, 8) // total length
  buf.writeUInt32LE(chunkLength, 12) // chunk 0 length
  buf.writeUInt32LE(0x4e4f534a, 16) // "JSON"
  jsonBytes.copy(buf, 20)
  return buf
}

describe('when parsing a .gltf buffer', () => {
  describe('and the document references textures and buffers', () => {
    let result: string[]

    beforeEach(() => {
      const gltf = JSON.stringify({
        images: [{ uri: 'textures/b.png' }, { uri: 'textures/a.png' }],
        buffers: [{ uri: 'buffer.bin' }]
      })
      result = parseGltfDepRefs(Buffer.from(gltf, 'utf8'), '.gltf')
    })

    it('should return the URIs sorted ASCIIbetically', () => {
      expect(result).toEqual(['buffer.bin', 'textures/a.png', 'textures/b.png'])
    })
  })

  describe('and the same URI is referenced from multiple entries', () => {
    let result: string[]

    beforeEach(() => {
      const gltf = JSON.stringify({
        images: [{ uri: 'tex.png' }, { uri: 'tex.png' }, { uri: 'other.png' }],
        buffers: [{ uri: 'b.bin' }, { uri: 'b.bin' }]
      })
      result = parseGltfDepRefs(Buffer.from(gltf, 'utf8'), '.gltf')
    })

    it('should collapse duplicates to one entry', () => {
      expect(result).toEqual(['b.bin', 'other.png', 'tex.png'])
    })
  })

  describe('and images use data URIs', () => {
    let result: string[]

    beforeEach(() => {
      const gltf = JSON.stringify({
        images: [{ uri: 'data:image/png;base64,AAAA' }, { uri: 'real.png' }],
        buffers: [{ uri: 'data:application/octet-stream;base64,AAAA' }]
      })
      result = parseGltfDepRefs(Buffer.from(gltf, 'utf8'), '.gltf')
    })

    it('should skip data URIs and return only external references', () => {
      expect(result).toEqual(['real.png'])
    })
  })

  describe('and entries lack a uri field', () => {
    let result: string[]

    beforeEach(() => {
      const gltf = JSON.stringify({
        images: [{ bufferView: 0 }, { uri: 'tex.png' }],
        buffers: [{ byteLength: 128 }]
      })
      result = parseGltfDepRefs(Buffer.from(gltf, 'utf8'), '.gltf')
    })

    it('should skip embedded entries', () => {
      expect(result).toEqual(['tex.png'])
    })
  })

  describe('and the images array contains null or primitive entries', () => {
    // Defensive: glTF spec requires object entries, but a malformed doc could
    // produce `images: [null]` or `images: ["tex.png"]`. Parser must skip,
    // not crash.
    let result: string[]

    beforeEach(() => {
      const gltf = JSON.stringify({
        images: [null, 'not-an-object', { uri: 'good.png' }, undefined]
      })
      result = parseGltfDepRefs(Buffer.from(gltf, 'utf8'), '.gltf')
    })

    it('should skip non-object entries and return only well-formed URIs', () => {
      expect(result).toEqual(['good.png'])
    })
  })

  describe('and the JSON is malformed', () => {
    it('should throw with a parse error', () => {
      const bytes = Buffer.from('{ not json', 'utf8')
      expect(() => parseGltfDepRefs(bytes, '.gltf')).toThrow(/glTF JSON parse failed/)
    })
  })

  describe('and the JSON payload is the literal value null', () => {
    // Regression guard: `JSON.parse("null")` returns `null` without throwing,
    // so a naive `doc.images` access would crash with `Cannot read properties
    // of null` that masks the real issue ("this glTF root isn't an object").
    it('should throw a descriptive root-type error instead of crashing', () => {
      const bytes = Buffer.from('null', 'utf8')
      expect(() => parseGltfDepRefs(bytes, '.gltf')).toThrow(/glTF root must be an object, got null/)
    })
  })

  describe('and the JSON payload is a primitive or array', () => {
    it('should throw a descriptive root-type error for a number', () => {
      expect(() => parseGltfDepRefs(Buffer.from('42', 'utf8'), '.gltf')).toThrow(/got number/)
    })

    it('should throw a descriptive root-type error for an array', () => {
      expect(() => parseGltfDepRefs(Buffer.from('[]', 'utf8'), '.gltf')).toThrow(/got array/)
    })
  })
})

describe('when parsing a .glb buffer', () => {
  describe('and the buffer is a well-formed glTF 2.0 binary with external references', () => {
    let result: string[]

    beforeEach(() => {
      const glb = buildGlb(JSON.stringify({ images: [{ uri: 'tex.png' }], buffers: [{ uri: 'b.bin' }] }))
      result = parseGltfDepRefs(glb, '.glb')
    })

    it('should extract URIs from the embedded JSON chunk', () => {
      expect(result).toEqual(['b.bin', 'tex.png'])
    })
  })

  describe('and two glbs carry the same dep set in reverse order', () => {
    let first: string[]
    let second: string[]

    beforeEach(() => {
      const a = buildGlb(JSON.stringify({ images: [{ uri: 'a.png' }, { uri: 'b.png' }] }))
      const b = buildGlb(JSON.stringify({ images: [{ uri: 'b.png' }, { uri: 'a.png' }] }))
      first = parseGltfDepRefs(a, '.glb')
      second = parseGltfDepRefs(b, '.glb')
    })

    it('should produce identical URI lists', () => {
      expect(first).toEqual(second)
    })
  })

  describe('and the magic bytes are wrong', () => {
    it('should throw a magic-mismatch error', () => {
      const bad = Buffer.alloc(20)
      bad.writeUInt32LE(0xdeadbeef, 0)
      expect(() => parseGltfDepRefs(bad, '.glb')).toThrow(/magic mismatch/)
    })
  })

  describe('and the version is not 2', () => {
    it('should throw an unsupported-version error', () => {
      const buf = Buffer.alloc(20)
      buf.writeUInt32LE(0x46546c67, 0)
      buf.writeUInt32LE(1, 4) // glTF 1.0 not supported
      buf.writeUInt32LE(20, 8)
      expect(() => parseGltfDepRefs(buf, '.glb')).toThrow(/unsupported glb version/)
    })
  })

  describe('and the buffer is truncated below the header size', () => {
    it('should throw a too-short error', () => {
      expect(() => parseGltfDepRefs(Buffer.alloc(8), '.glb')).toThrow(/glb too short/)
    })
  })

  describe('and the first chunk is not of type JSON', () => {
    it('should throw a not-JSON error', () => {
      const buf = Buffer.alloc(20)
      buf.writeUInt32LE(0x46546c67, 0)
      buf.writeUInt32LE(2, 4)
      buf.writeUInt32LE(20, 8)
      buf.writeUInt32LE(0, 12) // chunk length 0
      buf.writeUInt32LE(0x004e4942, 16) // BIN chunk first — invalid
      expect(() => parseGltfDepRefs(buf, '.glb')).toThrow(/first chunk is not JSON/)
    })
  })

  describe('and the JSON chunk declares a length beyond the buffer', () => {
    it('should throw an overrun error', () => {
      const buf = Buffer.alloc(20)
      buf.writeUInt32LE(0x46546c67, 0)
      buf.writeUInt32LE(2, 4)
      buf.writeUInt32LE(20, 8)
      buf.writeUInt32LE(9999, 12)
      buf.writeUInt32LE(0x4e4f534a, 16)
      expect(() => parseGltfDepRefs(buf, '.glb')).toThrow(/overruns buffer/)
    })
  })

  describe('and the JSON chunk is null-padded (non-spec-compliant exporters)', () => {
    // glTF 2.0 requires 0x20 space padding, but some older exporters emit 0x00.
    // `JSON.parse` rejects trailing nulls with "Unexpected non-whitespace
    // character"; our parser strips them to match Unity/GLTFast tolerance.
    let result: string[]

    beforeEach(() => {
      const jsonBody = JSON.stringify({ images: [{ uri: 'tex.png' }] })
      const jsonBytes = Buffer.from(jsonBody, 'utf8')
      // Pad to 4-byte alignment with 0x00 bytes instead of 0x20.
      const paddingNeeded = (4 - (jsonBytes.length % 4)) % 4
      const declaredChunkLen = jsonBytes.length + paddingNeeded
      const total = 12 + 8 + declaredChunkLen
      const buf = Buffer.alloc(total)
      buf.writeUInt32LE(0x46546c67, 0)
      buf.writeUInt32LE(2, 4)
      buf.writeUInt32LE(total, 8)
      buf.writeUInt32LE(declaredChunkLen, 12)
      buf.writeUInt32LE(0x4e4f534a, 16)
      jsonBytes.copy(buf, 20)
      // Remaining bytes stay as 0x00 from Buffer.alloc.
      result = parseGltfDepRefs(buf, '.glb')
    })

    it('should strip trailing null padding and parse the JSON cleanly', () => {
      expect(result).toEqual(['tex.png'])
    })
  })
})

describe('when resolving a glTF URI to an entity content key', () => {
  describe('and the glb sits at the entity root', () => {
    it('should return the URI unchanged for a same-directory reference', () => {
      expect(resolveUriToContentFile('tex.png', 'model.glb')).toBe('tex.png')
    })
  })

  describe('and the glb sits in a subdirectory', () => {
    it('should resolve a sibling URI relative to the glb location', () => {
      expect(resolveUriToContentFile('tex.png', 'models/car.glb')).toBe('models/tex.png')
    })

    it('should resolve an upward reference against the parent directory', () => {
      expect(resolveUriToContentFile('../textures/tex.png', 'models/car.glb')).toBe('textures/tex.png')
    })
  })

  describe('and the URI is percent-encoded', () => {
    it('should decode before returning', () => {
      expect(resolveUriToContentFile('tex%20with%20space.png', 'model.glb')).toBe('tex with space.png')
    })
  })

  describe('and the URI contains invalid percent-encoding', () => {
    it('should throw a decode error', () => {
      expect(() => resolveUriToContentFile('tex%2.png', 'model.glb')).toThrow(/invalid percent-encoding/)
    })
  })

  describe('and the URI resolves outside the entity root', () => {
    it('should throw an escape error', () => {
      expect(() => resolveUriToContentFile('../../etc/passwd', 'models/car.glb')).toThrow(/escapes entity root/)
    })
  })

  describe('and the URI is empty', () => {
    it('should throw with a clear "empty URI" error (not a misleading "not in entity content")', () => {
      expect(() => resolveUriToContentFile('', 'models/car.glb')).toThrow(/glTF URI is empty/)
    })
  })

  describe('and the URI has an absolute-URL scheme', () => {
    it.each([
      ['https://cdn.example.com/tex.png'],
      ['http://example.com/tex.png'],
      ['file:///tmp/tex.png'],
      ['ftp://example.com/tex.png']
    ])('should reject %s with a URI-scheme error', (uri) => {
      expect(() => resolveUriToContentFile(uri, 'models/car.glb')).toThrow(/has a URI scheme/)
    })
  })

  describe('and the URI is protocol-relative', () => {
    it('should reject with a protocol-relative error', () => {
      expect(() => resolveUriToContentFile('//cdn.example.com/tex.png', 'models/car.glb')).toThrow(
        /protocol-relative/
      )
    })
  })

  describe('and the URI is an absolute path', () => {
    it('should reject with an absolute-path error', () => {
      expect(() => resolveUriToContentFile('/tex.png', 'models/car.glb')).toThrow(/is an absolute path/)
    })
  })

  describe('and the URI contains a query string', () => {
    it('should reject with a query/fragment error', () => {
      expect(() => resolveUriToContentFile('tex.png?v=2', 'models/car.glb')).toThrow(
        /query\/fragment component/
      )
    })
  })

  describe('and the URI contains a fragment', () => {
    it('should reject with a query/fragment error', () => {
      expect(() => resolveUriToContentFile('tex.png#section', 'models/car.glb')).toThrow(
        /query\/fragment component/
      )
    })
  })

})
