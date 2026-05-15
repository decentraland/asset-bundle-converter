import type { PublisherComponent } from '../../src/types'

export type MockedPublisherComponent = jest.Mocked<PublisherComponent>

/**
 * Build an SNS-publisher mock. `publishMessage` defaults to a resolved
 * no-op so most tests don't have to set up an explicit return; override
 * with `.mockRejectedValueOnce` to drive the publish-failure paths.
 */
export function createPublisherMock(): MockedPublisherComponent {
  // `jest.fn()` with no impl is `Mock<unknown, unknown>` and assigns to the
  // typed property without an `unknown` cast. The happy-path default
  // (publishMessage resolves to undefined) is then applied via
  // `mockResolvedValue` so most tests don't have to set it up at the
  // call site; override with `.mockRejectedValueOnce` for failure paths.
  const mock: MockedPublisherComponent = {
    publishMessage: jest.fn()
  }
  mock.publishMessage.mockResolvedValue(undefined)
  return mock
}
