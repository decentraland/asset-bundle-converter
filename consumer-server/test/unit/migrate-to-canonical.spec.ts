import { buildBundlePattern, parseManifestKey } from '../../src/migrate-to-canonical'
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
