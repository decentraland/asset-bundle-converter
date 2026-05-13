import type { SentryComponent } from '../../src/adapters/sentry'

export type MockedSentryComponent = jest.Mocked<SentryComponent>

/**
 * Build a Sentry mock. Both methods default to no-op `jest.fn()`s — Sentry
 * is fire-and-forget in production, so returning `undefined` matches reality
 * and tests can still assert that `captureException` was called with
 * specific tags / extras.
 */
export function createSentryMock(): MockedSentryComponent {
  return {
    captureException: jest.fn(),
    captureMessage: jest.fn()
  } as unknown as MockedSentryComponent
}
