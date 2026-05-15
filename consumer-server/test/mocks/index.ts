// Centralised mock factories for the WKC components and the aws-sdk S3
// client. Each factory returns a fully-typed `jest.Mocked<...>` so tests
// can override per-method behaviour with `.mockResolvedValueOnce` /
// `.mockRejectedValueOnce` and assert calls via `.toHaveBeenCalledWith`
// without losing type information.

export { createCatalystMock, type MockedCatalystComponent } from './catalyst'
export { createCdnS3Mock, type MockedCdnS3 } from './cdn-s3'
export { createFilesystemMock, type MockedFilesystemComponent } from './filesystem'
export { createPublisherMock, type MockedPublisherComponent } from './publisher'
export { createScenesMock, type MockedScenesComponent } from './scenes'
export { createSentryMock, type MockedSentryComponent } from './sentry'
export { createUnityRunnerMock, type MockedUnityRunnerComponent } from './unity-runner'
