import { createSnsComponent as createDclSnsComponent } from '@dcl/sns-component'
import { AppComponents, PublisherComponent } from '../types'
import { AssetBundleConversionFinishedEvent, AssetBundleConversionManuallyQueuedEvent } from '@dcl/schemas'

// Thin wrapper around @dcl/sns-component. The @dcl component handles the
// AWS_SNS_ARN / AWS_SNS_ENDPOINT config wiring and builds the type/subType
// MessageAttributes (SNS filter policies rely on those); we keep a local
// wrapper solely to preserve the per-message publisher log line, which ops
// uses to trace which entity was announced downstream.
export async function createSnsComponent({
  config,
  logs
}: Pick<AppComponents, 'config' | 'logs'>): Promise<PublisherComponent> {
  const logger = logs.getLogger('publisher')
  const publisher = await createDclSnsComponent({ config })

  async function publishMessage(
    event: AssetBundleConversionFinishedEvent | AssetBundleConversionManuallyQueuedEvent
  ): Promise<void> {
    await publisher.publishMessage(event)
    logger.info('Published message to SNS', {
      entityId: event.metadata.entityId
    })
  }

  return { publishMessage }
}
