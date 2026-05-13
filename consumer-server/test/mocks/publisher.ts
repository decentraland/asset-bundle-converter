import type { PublisherComponent } from '../../src/types'

export type MockedPublisherComponent = jest.Mocked<PublisherComponent>

/**
 * Build an SNS-publisher mock. `publishMessage` defaults to a resolved
 * no-op so most tests don't have to set up an explicit return; override
 * with `.mockRejectedValueOnce` to drive the publish-failure paths.
 */
export function createPublisherMock(): MockedPublisherComponent {
  return {
    publishMessage: jest.fn(async () => undefined)
  } as unknown as MockedPublisherComponent
}
