import type { IScenesComponent } from '../../src/logic/scenes'

export type MockedScenesComponent = jest.Mocked<IScenesComponent>

/**
 * Build a scenes-component mock. Every method is a `jest.fn()` with no
 * default return — tests are expected to opt in per case:
 *
 * ```ts
 * const scenes = createScenesMock()
 * scenes.probe.mockResolvedValueOnce({ kind: 'full-hit', ... })
 * ```
 *
 * For tests that mock the upstream `executeConversion` / `executeTriagePass`
 * at module scope (and therefore should never reach into scenes), pair this
 * with explicit `expect(scenes.probe).not.toHaveBeenCalled()` assertions.
 */
export function createScenesMock(): MockedScenesComponent {
  return {
    probe: jest.fn(),
    uploadFastPathResult: jest.fn(),
    purgeCachedBundlesFromOutput: jest.fn(),
    getCdnBucket: jest.fn(),
    manifestKeyForEntity: jest.fn(),
    uploadEntityManifest: jest.fn(),
    uploadSceneSourceFilesToCDN: jest.fn()
  } as unknown as MockedScenesComponent
}
