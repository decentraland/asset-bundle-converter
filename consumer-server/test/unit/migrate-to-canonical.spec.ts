import { buildBundlePattern, parseManifestKey, splitBundleName } from '../../src/migrate-to-canonical'
import { canonicalFilename, computeDepsDigest, fileExtension } from '../../src/logic/asset-reuse'
import { isS3NotFound } from '../../src/logic/s3-helpers'

describe('when parsing a manifest key', () => {
  describe('and given a WebGL manifest key', () => {
    it('should default to webgl target when no suffix is present', () => {
      expect(parseManifestKey('manifest/bafkreiabc.json')).toEqual({
        entityId: 'bafkreiabc',
        target: 'webgl'
      })
    })
  })

  describe('and given a windows manifest key', () => {
    it('should split off the _windows suffix as the target', () => {
      expect(parseManifestKey('manifest/bafkreiabc_windows.json')).toEqual({
        entityId: 'bafkreiabc',
        target: 'windows'
      })
    })
  })

  describe('and given a mac manifest key', () => {
    it('should split off the _mac suffix as the target', () => {
      expect(parseManifestKey('manifest/bafkreiabc_mac.json')).toEqual({
        entityId: 'bafkreiabc',
        target: 'mac'
      })
    })
  })

  describe('and given a _failed sentinel key', () => {
    it('should return null so the migration skips it', () => {
      expect(parseManifestKey('manifest/bafkreiabc_failed.json')).toBeNull()
    })
  })

  describe('and given a key with no manifest/ prefix', () => {
    it('should still parse — the prefix strip is tolerant', () => {
      // Real callers always pass `manifest/...`; the stripping is defensive.
      expect(parseManifestKey('bafkreiabc.json')).toEqual({
        entityId: 'bafkreiabc',
        target: 'webgl'
      })
    })
  })

  describe('and given an empty base name', () => {
    it('should return null', () => {
      expect(parseManifestKey('manifest/.json')).toBeNull()
    })
  })

  describe('and the entity id itself contains an underscore', () => {
    it('should only strip the known target suffix, not arbitrary underscores', () => {
      // 'entity_with_underscores' is the entityId; '_windows' is the real target.
      expect(parseManifestKey('manifest/entity_with_underscores_windows.json')).toEqual({
        entityId: 'entity_with_underscores',
        target: 'windows'
      })
    })

    it('should NOT split a non-target trailing segment (treats as webgl entityId)', () => {
      // 'bafkreiabc_something' has a non-target trailing segment, so the whole thing
      // is the entityId and target defaults to webgl.
      expect(parseManifestKey('manifest/bafkreiabc_something.json')).toEqual({
        entityId: 'bafkreiabc_something',
        target: 'webgl'
      })
    })
  })
})

describe('when building the bundle-filename regex', () => {
  describe('and matching bundle filenames for a target', () => {
    let pattern: RegExp

    beforeEach(() => {
      pattern = buildBundlePattern('windows')
    })

    it('should match the raw bundle', () => {
      expect(pattern.test('bafkreiabc_windows')).toBe(true)
    })

    it('should match the brotli variant', () => {
      expect(pattern.test('bafkreiabc_windows.br')).toBe(true)
    })

    it('should match the Unity per-bundle manifest', () => {
      expect(pattern.test('bafkreiabc_windows.manifest')).toBe(true)
    })

    it('should match the brotli-compressed manifest', () => {
      expect(pattern.test('bafkreiabc_windows.manifest.br')).toBe(true)
    })

    it('should reject a bundle for a different target', () => {
      expect(pattern.test('bafkreiabc_mac')).toBe(false)
      expect(pattern.test('bafkreiabc_webgl')).toBe(false)
    })

    it('should reject generic Unity artifacts without a hash prefix', () => {
      expect(pattern.test('AssetBundles')).toBe(false)
      expect(pattern.test('AssetBundles.manifest')).toBe(false)
    })

    it('should reject a bare hash with no target suffix', () => {
      expect(pattern.test('bafkreiabc')).toBe(false)
    })

    it('should reject a path-traversal-style filename', () => {
      // `[^/]+` disallows forward slashes in the leading segment.
      expect(pattern.test('../etc/passwd_windows')).toBe(false)
    })
  })

  describe('and building a pattern for webgl', () => {
    it('should not accidentally match windows or mac bundles', () => {
      const pattern = buildBundlePattern('webgl')
      expect(pattern.test('bafkreiabc_webgl')).toBe(true)
      expect(pattern.test('bafkreiabc_windows')).toBe(false)
      expect(pattern.test('bafkreiabc_mac')).toBe(false)
    })
  })
})

describe('when detecting an S3 not-found error', () => {
  describe('and given an S3 NotFound error from AWS SDK v2', () => {
    it('should return true for statusCode 404', () => {
      expect(isS3NotFound({ statusCode: 404 })).toBe(true)
    })

    it("should return true for code 'NotFound'", () => {
      expect(isS3NotFound({ code: 'NotFound' })).toBe(true)
    })

    it("should return true for code 'NoSuchKey'", () => {
      expect(isS3NotFound({ code: 'NoSuchKey' })).toBe(true)
    })
  })

  describe('and given a different kind of S3 error', () => {
    it('should return false for statusCode 500', () => {
      expect(isS3NotFound({ statusCode: 500 })).toBe(false)
    })

    it("should return false for code 'AccessDenied'", () => {
      expect(isS3NotFound({ code: 'AccessDenied' })).toBe(false)
    })

    it('should return false for a plain Error', () => {
      expect(isS3NotFound(new Error('boom'))).toBe(false)
    })
  })

  describe('and given nullish input', () => {
    it('should return false', () => {
      expect(isS3NotFound(null)).toBe(false)
      expect(isS3NotFound(undefined)).toBe(false)
    })
  })
})

// Pin that the migration script's rename composition — `splitBundleName` then
// `canonicalFilename(…, computeDepsDigest(entity.content))` — produces the
// exact same key a fresh conversion would upload to. The migrate script
// shares the `canonicalFilename`/`computeDepsDigest` helpers with the live
// converter, but parses pre-PR filenames through its own `splitBundleName`;
// silent drift in that parser would deposit migrated bundles at paths the
// runtime probe never hits, silently poisoning the canonical prefix.
describe('when the migration script derives a canonical destination key', () => {
  function deriveMigratedKey(sourceFilename: string, target: string, abVersion: string, entityContent: { file: string; hash: string }[]): string | null {
    const parts = splitBundleName(sourceFilename, target)
    if (!parts) return null
    const extByHash = new Map<string, string>()
    for (const c of entityContent) extByHash.set(c.hash, fileExtension(c.file))
    const ext = extByHash.get(parts.hash) ?? ''
    const depsDigest = computeDepsDigest(entityContent)
    const destFilename = `${canonicalFilename(parts.hash, ext, target, depsDigest)}${parts.variant}`
    return `${abVersion}/assets/${destFilename}`
  }

  describe('and the source is a bare glb bundle on an entity with textures', () => {
    it('should land at the same composite path a fresh conversion would upload', () => {
      const entityContent = [
        { file: 'model.glb', hash: 'hGlb' },
        { file: 'diffuse.png', hash: 'hTex' }
      ]
      const digest = computeDepsDigest(entityContent)
      const expected = `v48/assets/${canonicalFilename('hGlb', '.glb', 'windows', digest)}`

      expect(deriveMigratedKey('hGlb_windows', 'windows', 'v48', entityContent)).toBe(expected)
    })
  })

  describe('and the source is the brotli variant of a glb bundle', () => {
    it('should preserve the .br suffix on the composite destination', () => {
      const entityContent = [
        { file: 'model.glb', hash: 'hGlb' },
        { file: 'diffuse.png', hash: 'hTex' }
      ]
      const digest = computeDepsDigest(entityContent)
      const expected = `v48/assets/${canonicalFilename('hGlb', '.glb', 'windows', digest)}.br`

      expect(deriveMigratedKey('hGlb_windows.br', 'windows', 'v48', entityContent)).toBe(expected)
    })
  })

  describe('and the source is a texture bundle (leaf, bare hash form)', () => {
    it('should stay bare with no digest folded in', () => {
      const entityContent = [
        { file: 'model.glb', hash: 'hGlb' },
        { file: 'diffuse.png', hash: 'hTex' }
      ]

      expect(deriveMigratedKey('hTex_windows', 'windows', 'v48', entityContent)).toBe('v48/assets/hTex_windows')
    })
  })

  describe('and the source is a Unity per-bundle manifest', () => {
    it('should preserve the .manifest suffix on the composite destination', () => {
      const entityContent = [
        { file: 'model.glb', hash: 'hGlb' },
        { file: 'diffuse.png', hash: 'hTex' }
      ]
      const digest = computeDepsDigest(entityContent)
      const expected = `v48/assets/${canonicalFilename('hGlb', '.glb', 'windows', digest)}.manifest`

      expect(deriveMigratedKey('hGlb_windows.manifest', 'windows', 'v48', entityContent)).toBe(expected)
    })
  })

  describe('and the source hash is not present in the entity content', () => {
    it('should fall back to bare form because the extension lookup resolves to empty', () => {
      // Defensive: a pre-PR manifest may list a hash whose entity content entry
      // has been rotated out by the time the migration runs. We don't want the
      // script to throw; instead it just copies to the bare canonical form
      // (same hash, same target, no digest) which matches what a fresh run
      // would produce for an unrecognized extension.
      const entityContent = [{ file: 'diffuse.png', hash: 'hTex' }]

      expect(deriveMigratedKey('hOrphan_windows', 'windows', 'v48', entityContent)).toBe('v48/assets/hOrphan_windows')
    })
  })

  describe('and the source filename is already in composite form', () => {
    it('should be rejected by splitBundleName (not migrateable)', () => {
      // Composite names ship from the live converter, not this script — they
      // have a `_` inside the hash-slot, so the `[^_]+` capture refuses.
      expect(splitBundleName('hGlb_abcd1234abcd1234abcd1234abcd1234_windows', 'windows')).toBeNull()
    })
  })
})
