import { PublishCommand, SNSClient } from '@aws-sdk/client-sns'
import { AppComponents, PublisherComponent } from '../types'

export async function createSnsComponent({
  config,
}: Pick<AppComponents, 'config'>): Promise<PublisherComponent> {
  const snsArn = await config.requireString('AWS_SNS_ARN')
  const optionalEndpoint = await config.getString('AWS_SNS_ENDPOINT')

  const client = new SNSClient({
    endpoint: optionalEndpoint ? optionalEndpoint : undefined,
  })

  async function publishMessage(event: any): Promise<void> {
      const command = new PublishCommand({
        TopicArn: snsArn,
        Message: JSON.stringify(event),
        MessageAttributes: {
          type: {
            DataType: 'String',
            StringValue: event.type,
          },
          subType: {
            DataType: 'String',
            StringValue: event.subType,
          },
        },
      })

      await client.send(command)
  }

  return { publishMessage }
}