import type { ICatalystComponent } from '../../src/adapters/catalyst'

/**
 * A fully-typed catalyst component where every method is a `jest.Mock`. Tests
 * can call `.mockResolvedValueOnce` / `.mockRejectedValueOnce` to drive
 * specific behaviour, and assert against calls without casting.
 */
export type MockedCatalystComponent = jest.Mocked<ICatalystComponent>

/**
 * Build a catalyst mock with every method initialised to an unresolved
 * `jest.fn()`. Override per-method behaviour at the test site:
 *
 * ```ts
 * const catalyst = createCatalystMock()
 * catalyst.getActiveEntity.mockResolvedValueOnce(entityFixture)
 * ```
 *
 * Defaults are deliberately not "resolved" so a test that forgets to set up
 * an expected return value fails loudly (pending promise / undefined return)
 * rather than masking a missed assertion.
 */
export function createCatalystMock(): MockedCatalystComponent {
  return {
    getActiveEntity: jest.fn(),
    getEntities: jest.fn()
  } as unknown as MockedCatalystComponent
}
