import { buildBundlePattern, parseManifestKey, isNotFound } from '../../src/migrate-to-canonical'

describe('parseManifestKey', () => {
  describe('when given a WebGL manifest key', () => {
    it('should default to webgl target when no suffix is present', () => {
      expect(parseManifestKey('manifest/bafkreiabc.json')).toEqual({
        entityId: 'bafkreiabc',
        target: 'webgl'
      })
    })
  })

  describe('when given a windows manifest key', () => {
    it('should split off the _windows suffix as the target', () => {
      expect(parseManifestKey('manifest/bafkreiabc_windows.json')).toEqual({
        entityId: 'bafkreiabc',
        target: 'windows'
      })
    })
  })

  describe('when given a mac manifest key', () => {
    it('should split off the _mac suffix as the target', () => {
      expect(parseManifestKey('manifest/bafkreiabc_mac.json')).toEqual({
        entityId: 'bafkreiabc',
        target: 'mac'
      })
    })
  })

  describe('when given a _failed sentinel key', () => {
    it('should return null so the migration skips it', () => {
      expect(parseManifestKey('manifest/bafkreiabc_failed.json')).toBeNull()
    })
  })

  describe('when given a key with no manifest/ prefix', () => {
    it('should still parse — the prefix strip is tolerant', () => {
      // Real callers always pass `manifest/...`; the stripping is defensive.
      expect(parseManifestKey('bafkreiabc.json')).toEqual({
        entityId: 'bafkreiabc',
        target: 'webgl'
      })
    })
  })

  describe('when given an empty base name', () => {
    it('should return null', () => {
      expect(parseManifestKey('manifest/.json')).toBeNull()
    })
  })

  describe('when the entity id itself contains an underscore', () => {
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

describe('buildBundlePattern', () => {
  describe('when matching bundle filenames for a target', () => {
    const pattern = buildBundlePattern('windows')

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

  describe('when building a pattern for webgl', () => {
    it('should not accidentally match windows or mac bundles', () => {
      const pattern = buildBundlePattern('webgl')
      expect(pattern.test('bafkreiabc_webgl')).toBe(true)
      expect(pattern.test('bafkreiabc_windows')).toBe(false)
      expect(pattern.test('bafkreiabc_mac')).toBe(false)
    })
  })
})

describe('isNotFound', () => {
  describe('when given an S3 NotFound error from AWS SDK v2', () => {
    it('should return true for statusCode 404', () => {
      expect(isNotFound({ statusCode: 404 })).toBe(true)
    })

    it("should return true for code 'NotFound'", () => {
      expect(isNotFound({ code: 'NotFound' })).toBe(true)
    })

    it("should return true for code 'NoSuchKey'", () => {
      expect(isNotFound({ code: 'NoSuchKey' })).toBe(true)
    })
  })

  describe('when given a different kind of S3 error', () => {
    it('should return false for statusCode 500', () => {
      expect(isNotFound({ statusCode: 500 })).toBe(false)
    })

    it("should return false for code 'AccessDenied'", () => {
      expect(isNotFound({ code: 'AccessDenied' })).toBe(false)
    })

    it('should return false for a plain Error', () => {
      expect(isNotFound(new Error('boom'))).toBe(false)
    })
  })

  describe('when given nullish input', () => {
    it('should return false', () => {
      expect(isNotFound(null)).toBe(false)
      expect(isNotFound(undefined)).toBe(false)
    })
  })
})
