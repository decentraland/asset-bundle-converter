import type { IUnityRunnerComponent } from '../../src/adapters/unity-runner'

export type MockedUnityRunnerComponent = jest.Mocked<IUnityRunnerComponent>

/**
 * Build a unity-runner mock. Both methods default to unresolved `jest.fn()`s
 * so tests must opt into return behaviour explicitly:
 *
 * ```ts
 * const unityRunner = createUnityRunnerMock()
 * unityRunner.runConversion.mockResolvedValueOnce(0)
 * ```
 */
export function createUnityRunnerMock(): MockedUnityRunnerComponent {
  return {
    runConversion: jest.fn(),
    runLodsConversion: jest.fn()
  } as unknown as MockedUnityRunnerComponent
}
