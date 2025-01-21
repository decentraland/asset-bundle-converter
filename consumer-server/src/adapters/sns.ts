import { PublishCommand, SNSClient } from '@aws-sdk/client-sns'
import { AppComponents, PublisherComponent } from '../types'
import { AssetBundleConversionFinishedEvent, AssetBundleConversionManuallyQueuedEvent } from '@dcl/schemas'

export async function createSnsComponent({
  config,
  logs
}: Pick<AppComponents, 'config' | 'logs'>): Promise<PublisherComponent> {
  const logger = logs.getLogger('publisher')
  const snsArn = await config.requireString('AWS_SNS_ARN')
  const optionalEndpoint = await config.getString('AWS_SNS_ENDPOINT')

  const client = new SNSClient({
    endpoint: optionalEndpoint ? optionalEndpoint : undefined
  })

  async function publishMessage(
    event: AssetBundleConversionFinishedEvent | AssetBundleConversionManuallyQueuedEvent
  ): Promise<void> {
    let messageAttributes: any = {
      type: {
        DataType: 'String',
        StringValue: event.type
      },
      subType: {
        DataType: 'String',
        StringValue: event.subType
      }
    }

    if ('isPriority' in event.metadata && event.metadata.isPriority) {
      messageAttributes = {
        ...messageAttributes,
        priority: { DataType: 'String', StringValue: '1' }
      }
    }

    const command = new PublishCommand({
      TopicArn: snsArn,
      Message: JSON.stringify(event),
      MessageAttributes: messageAttributes
    })

    await client.send(command)
    logger.info('Published message to SNS', {
      entityId: event.metadata.entityId
    })
  }

  return { publishMessage }
}
