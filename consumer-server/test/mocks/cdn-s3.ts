/**
 * The aws-sdk v2 S3 client used by the production components isn't a WKC
 * component — it's an instance with chainable `.upload(params).promise()`
 * call shapes. Tests need to control both the return values and the
 * jest.fn introspection at the call layer, so the mock exposes the inner
 * `.upload` / `.getObject` / `.headObject` jest.fns directly while keeping
 * the `.promise()` indirection on each return value.
 *
 * Default behaviour: every operation resolves to an empty result, `getObject`
 * returns `Body: undefined`. Override per test by calling
 * `mock.upload.mockReturnValueOnce({ promise: jest.fn(async () => …) })` etc.
 */
export type MockedCdnS3 = {
  upload: jest.Mock
  getObject: jest.Mock
  headObject: jest.Mock
}

export function createCdnS3Mock(): MockedCdnS3 {
  return {
    upload: jest.fn(() => ({ promise: jest.fn(async () => ({})) })),
    getObject: jest.fn(() => ({ promise: jest.fn(async () => ({ Body: undefined })) })),
    headObject: jest.fn(() => ({ promise: jest.fn(async () => ({})) }))
  }
}
