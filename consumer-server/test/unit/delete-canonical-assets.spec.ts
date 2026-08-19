// Unit coverage for the destructive delete-canonical-assets ops script. The
// two things that matter most here are the safety defaults (dry-run never
// mutates) and the input guards (entity IDs must be bare CIDs before they
// reach an S3 key), so those get the most attention alongside the pure
// filename/parsing helpers.

import {
  buildTargetFilter,
  ENTITY_ID_RE,
  manifestCandidateKeys,
  parseEntityIdsFile,
  runDeletion,
  runManifestDeletion
} from '../../src/delete-canonical-assets'

type S3Object = { Key: string; Size?: number }

// Fake S3 for assets mode: a single-page `listObjectsV2` plus a `deleteObjects`
// spy so tests can assert exactly what (if anything) was deleted.
function makeAssetsS3(objects: S3Object[]) {
  const listObjectsV2 = jest.fn(() => ({
    promise: async () => ({ Contents: objects, IsTruncated: false })
  }))
  const deleteObjects = jest.fn(() => ({ promise: async () => ({}) }))
  const s3: any = { listObjectsV2, deleteObjects }
  return { s3, listObjectsV2, deleteObjects }
}

// Fake S3 for manifests mode: `headObject` resolves for keys in `existingKeys`
// and throws a 404-shaped error otherwise; `deleteObjects` is a spy.
function makeManifestsS3(existingKeys: Set<string>) {
  const headObject = jest.fn((params: { Key: string }) => ({
    promise: async () => {
      if (existingKeys.has(params.Key)) return { ContentLength: 1 }
      const err: any = new Error('NotFound')
      err.code = 'NotFound'
      err.statusCode = 404
      throw err
    }
  }))
  const deleteObjects = jest.fn(() => ({ promise: async () => ({}) }))
  const s3: any = { headObject, deleteObjects }
  return { s3, headObject, deleteObjects }
}

describe('when building the canonical-bundle target filter', () => {
  let filter: RegExp

  beforeEach(() => {
    filter = buildTargetFilter('windows')
  })

  it('should match the raw {hash}_{target} leaf', () => {
    expect(filter.test('bafkreiabc_windows')).toBe(true)
  })

  it('should match the per-glb {hash}_{digest}_{target} form', () => {
    expect(filter.test('bafkreiabc_deadbeef_windows')).toBe(true)
  })

  it('should match the brotli variant', () => {
    expect(filter.test('bafkreiabc_windows.br')).toBe(true)
  })

  it('should match the Unity per-bundle manifest', () => {
    expect(filter.test('bafkreiabc_windows.manifest')).toBe(true)
  })

  it('should match the brotli-compressed manifest', () => {
    expect(filter.test('bafkreiabc_windows.manifest.br')).toBe(true)
  })

  it('should reject a filename for a different target', () => {
    expect(filter.test('bafkreiabc_mac')).toBe(false)
  })

  it('should reject a filename with no target suffix', () => {
    expect(filter.test('bafkreiabc.json')).toBe(false)
  })
})

describe('when building candidate manifest keys for an entity', () => {
  describe('and no target filter is given', () => {
    let keys: string[]

    beforeEach(() => {
      keys = manifestCandidateKeys('bafkreiabc')
    })

    it('should return the bare, windows, mac, and _failed keys', () => {
      expect(keys).toEqual([
        'manifest/bafkreiabc.json',
        'manifest/bafkreiabc_windows.json',
        'manifest/bafkreiabc_mac.json',
        'manifest/bafkreiabc_failed.json'
      ])
    })
  })

  describe('and the target is windows', () => {
    it('should return only the windows manifest key', () => {
      expect(manifestCandidateKeys('bafkreiabc', 'windows')).toEqual(['manifest/bafkreiabc_windows.json'])
    })
  })

  describe('and the target is mac', () => {
    it('should return only the mac manifest key', () => {
      expect(manifestCandidateKeys('bafkreiabc', 'mac')).toEqual(['manifest/bafkreiabc_mac.json'])
    })
  })

  describe('and the target is webgl', () => {
    it('should return only the bare (unsuffixed) manifest key', () => {
      expect(manifestCandidateKeys('bafkreiabc', 'webgl')).toEqual(['manifest/bafkreiabc.json'])
    })
  })
})

describe('when parsing an entity-ids file', () => {
  describe('and the file has ids, blank lines, and comments', () => {
    let ids: string[]

    beforeEach(() => {
      ids = parseEntityIdsFile('bafkreione\n\n  bafkreitwo  \n# a comment\nbafkreithree\n')
    })

    it('should return only the non-blank, non-comment ids, trimmed', () => {
      expect(ids).toEqual(['bafkreione', 'bafkreitwo', 'bafkreithree'])
    })
  })

  describe('and the file is empty', () => {
    it('should return an empty array', () => {
      expect(parseEntityIdsFile('')).toEqual([])
    })
  })
})

describe('when validating an entity id against the bare-CID guard', () => {
  it('should accept a bare CID', () => {
    expect(ENTITY_ID_RE.test('bafkreie7jn6nvmgmy4dlgblwmue5zqcpd52autcengvmt2moz2mcid5ez4')).toBe(true)
  })

  it('should reject an id containing path separators', () => {
    expect(ENTITY_ID_RE.test('../evil')).toBe(false)
  })

  it('should reject an id containing a slash', () => {
    expect(ENTITY_ID_RE.test('manifest/other')).toBe(false)
  })
})

describe('when running the canonical-asset deletion', () => {
  const bucket = 'test-bucket'
  const abVersion = 'v48'

  describe('and execute is false (dry run)', () => {
    let result: Awaited<ReturnType<typeof runDeletion>>
    let deleteObjects: jest.Mock

    beforeEach(async () => {
      const mock = makeAssetsS3([
        { Key: 'v48/assets/hashA_windows', Size: 10 },
        { Key: 'v48/assets/hashB_windows.br', Size: 20 },
        { Key: 'v48/assets/hashC_mac', Size: 30 }
      ])
      deleteObjects = mock.deleteObjects
      result = await runDeletion({ s3: mock.s3, bucket, abVersion, target: 'windows', execute: false })
    })

    afterEach(() => {
      jest.clearAllMocks()
    })

    it('should never call deleteObjects', () => {
      expect(deleteObjects).not.toHaveBeenCalled()
    })

    it('should still report the matched count and bytes for the target', () => {
      expect(result).toMatchObject({ objectsScanned: 3, objectsMatched: 2, objectsDeleted: 0, bytesMatched: 30 })
    })
  })

  describe('and execute is true with a target filter', () => {
    let result: Awaited<ReturnType<typeof runDeletion>>
    let deleteObjects: jest.Mock

    beforeEach(async () => {
      const mock = makeAssetsS3([
        { Key: 'v48/assets/hashA_windows', Size: 10 },
        { Key: 'v48/assets/hashB_windows.br', Size: 20 },
        { Key: 'v48/assets/hashC_mac', Size: 30 }
      ])
      deleteObjects = mock.deleteObjects
      result = await runDeletion({ s3: mock.s3, bucket, abVersion, target: 'windows', execute: true })
    })

    afterEach(() => {
      jest.clearAllMocks()
    })

    it('should delete only the objects matching the target suffix', () => {
      expect(deleteObjects.mock.calls[0][0].Delete.Objects).toEqual([
        { Key: 'v48/assets/hashA_windows' },
        { Key: 'v48/assets/hashB_windows.br' }
      ])
    })

    it('should report the deleted count', () => {
      expect(result.objectsDeleted).toBe(2)
    })
  })

  describe('and execute is true with no target filter', () => {
    let result: Awaited<ReturnType<typeof runDeletion>>

    beforeEach(async () => {
      const mock = makeAssetsS3([
        { Key: 'v48/assets/hashA_windows', Size: 10 },
        { Key: 'v48/assets/hashC_mac', Size: 30 }
      ])
      result = await runDeletion({ s3: mock.s3, bucket, abVersion, execute: true })
    })

    afterEach(() => {
      jest.clearAllMocks()
    })

    it('should delete every object under the prefix regardless of target', () => {
      expect(result.objectsDeleted).toBe(2)
    })
  })

  describe('and there are more matched objects than the S3 batch size', () => {
    let deleteObjects: jest.Mock

    beforeEach(async () => {
      const objects = Array.from({ length: 2500 }, (_v, i) => ({ Key: `v48/assets/hash${i}_windows`, Size: 1 }))
      const mock = makeAssetsS3(objects)
      deleteObjects = mock.deleteObjects
      await runDeletion({ s3: mock.s3, bucket, abVersion, target: 'windows', execute: true })
    })

    afterEach(() => {
      jest.clearAllMocks()
    })

    it('should delete them in batches of at most 1000 keys', () => {
      const batchSizes = deleteObjects.mock.calls.map((c) => c[0].Delete.Objects.length)
      expect(batchSizes).toEqual([1000, 1000, 500])
    })
  })
})

describe('when running the manifest deletion', () => {
  const bucket = 'test-bucket'

  describe('and execute is false (dry run)', () => {
    let result: Awaited<ReturnType<typeof runManifestDeletion>>
    let deleteObjects: jest.Mock

    beforeEach(async () => {
      const mock = makeManifestsS3(new Set(['manifest/bafkreiabc_windows.json']))
      deleteObjects = mock.deleteObjects
      result = await runManifestDeletion({
        s3: mock.s3,
        bucket,
        entityIds: ['bafkreiabc'],
        target: 'windows',
        execute: false
      })
    })

    afterEach(() => {
      jest.clearAllMocks()
    })

    it('should report the found manifest without deleting it', () => {
      expect(result).toMatchObject({ manifestsFound: 1, manifestsDeleted: 0 })
    })

    it('should never call deleteObjects', () => {
      expect(deleteObjects).not.toHaveBeenCalled()
    })
  })

  describe('and execute is true', () => {
    let result: Awaited<ReturnType<typeof runManifestDeletion>>
    let deleteObjects: jest.Mock

    beforeEach(async () => {
      const mock = makeManifestsS3(new Set(['manifest/bafkreiabc_windows.json']))
      deleteObjects = mock.deleteObjects
      result = await runManifestDeletion({
        s3: mock.s3,
        bucket,
        entityIds: ['bafkreiabc'],
        target: 'windows',
        execute: true
      })
    })

    afterEach(() => {
      jest.clearAllMocks()
    })

    it('should delete only the manifest key that exists', () => {
      expect(deleteObjects.mock.calls[0][0].Delete.Objects).toEqual([{ Key: 'manifest/bafkreiabc_windows.json' }])
    })

    it('should report the deleted count', () => {
      expect(result.manifestsDeleted).toBe(1)
    })
  })

  describe('and an entity id is not a bare CID', () => {
    let result: Awaited<ReturnType<typeof runManifestDeletion>>
    let headObject: jest.Mock

    beforeEach(async () => {
      const mock = makeManifestsS3(new Set())
      headObject = mock.headObject
      result = await runManifestDeletion({
        s3: mock.s3,
        bucket,
        entityIds: ['../evil', 'bafkreigood'],
        target: 'windows',
        execute: true
      })
    })

    afterEach(() => {
      jest.clearAllMocks()
    })

    it('should count the malformed id as invalid', () => {
      expect(result.entityIdsInvalid).toBe(1)
    })

    it('should only process and probe the valid id', () => {
      expect(result).toMatchObject({ entityIdsProcessed: 1, candidatesProbed: 1 })
    })

    it('should never issue a HEAD against a key built from the malformed id', () => {
      const probedKeys = headObject.mock.calls.map((c) => c[0].Key)
      expect(probedKeys).toEqual(['manifest/bafkreigood_windows.json'])
    })
  })

  describe('and the input contains duplicate ids', () => {
    let result: Awaited<ReturnType<typeof runManifestDeletion>>
    let headObject: jest.Mock

    beforeEach(async () => {
      const mock = makeManifestsS3(new Set())
      headObject = mock.headObject
      result = await runManifestDeletion({
        s3: mock.s3,
        bucket,
        entityIds: ['bafkreiabc', 'bafkreiabc'],
        target: 'windows',
        execute: false
      })
    })

    afterEach(() => {
      jest.clearAllMocks()
    })

    it('should dedupe before probing so the id is processed once', () => {
      expect(result.entityIdsProcessed).toBe(1)
    })

    it('should probe each candidate key only once', () => {
      expect(headObject).toHaveBeenCalledTimes(1)
    })
  })
})
