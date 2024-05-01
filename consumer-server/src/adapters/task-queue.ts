import { IBaseComponent, IMetricsComponent } from '@well-known-components/interfaces'
import { validateMetricsDeclaration } from '@well-known-components/metrics'
import { AsyncQueue } from '@well-known-components/pushable-channel'
import { SQS } from 'aws-sdk'
import { sleep, timeout } from '../logic/timer'
import { AppComponents } from '../types'

export interface TaskQueueMessage {
  id: string
}

export interface ITaskQueue<T> {
  // publishes a job for the queue
  publish(job: T, prioritize?: boolean): Promise<TaskQueueMessage>
  // awaits for a job. then calls and waits for the taskRunner argument.
  // the result is then returned to the wrapper function.
  consumeAndProcessJob<R>(taskRunner: (job: T, message: TaskQueueMessage) => Promise<R>): Promise<{ result: R | undefined }>
}

export const queueMetrics = validateMetricsDeclaration({
  job_queue_duration_seconds: {
    type: IMetricsComponent.HistogramType,
    help: 'Duration of each job in seconds',
    labelNames: ["queue_name"],
    buckets: [1, 10, 100, 200, 300, 400, 500, 600, 700, 1000, 1200, 1600, 1800, 3600]
  },
  job_queue_enqueue_total: {
    type: IMetricsComponent.CounterType,
    help: "Total amount of enqueued jobs",
    labelNames: ["queue_name"],
  },
  job_queue_failures_total: {
    type: IMetricsComponent.CounterType,
    help: "Total amount of failed tasks",
    labelNames: ["queue_name"],
  },
})

type SNSOverSQSMessage = {
  Message: string
}


export function createMemoryQueueAdapter<T>(components: Pick<AppComponents, "logs" | 'metrics'>, options: { queueName: string }): ITaskQueue<T> & IBaseComponent {
  type InternalElement = { message: TaskQueueMessage, job: T }
  const q = new AsyncQueue<InternalElement>((action) => void 0)
  let lastJobId = 0

  const logger = components.logs.getLogger(options.queueName)

  return {
    async stop() {
      q.close()
    },
    async publish(job) {
      const id = 'job-' + (++lastJobId).toString()
      const message: TaskQueueMessage = { id }
      q.enqueue({ job, message })
      logger.info(`Publishing job`, { id })
      components.metrics.increment('job_queue_enqueue_total', { queue_name: options.queueName })
      return message
    },
    async consumeAndProcessJob(taskRunner) {
      const it: InternalElement = (await q.next()).value
      if (it) {
        const { end } = components.metrics.startTimer('job_queue_duration_seconds', { queue_name: options.queueName })
        try {
          logger.info(`Processing job`, { id: it.message.id })
          const result = await taskRunner(it.job, it.message)
          logger.info(`Processed job`, { id: it.message.id })
          return { result, message: it.message }
        } catch (err: any) {
          components.metrics.increment('job_queue_failures_total', { queue_name: options.queueName })
          logger.error(err, { id: it.message.id })
          // q.enqueue(it)
        } finally {
          end()
        }
      }
      return { result: undefined }
    },
  }
}

export function createSqsAdapter<T>(components: Pick<AppComponents, "logs" | 'metrics'>, options: { queueUrl: string, priorityQueueUrl?: string, queueRegion?: string }): ITaskQueue<T> {
  const logger = components.logs.getLogger(options.queueUrl)

  const sqs = new SQS({ apiVersion: 'latest', region: options.queueRegion })

  async function removeMessageFromQueues(receiptHandle: string, queuesUrl: string[]) {
    try {
      const queueUrl = queuesUrl[0]
      await sqs.deleteMessage({ QueueUrl: queueUrl, ReceiptHandle: receiptHandle }).promise()
      logger.info(`Deleted message from queue`, { receiptHandle, queueUrl })
    } catch (error: any) {
      logger.error(`Error deleting message from queue`, { error: error.message, code: error.code })
      if (error.code === 'ReceiptHandleIsInvalid' && queuesUrl.length > 1) {
        return await removeMessageFromQueues(receiptHandle, queuesUrl.slice(1))
      } else {
        throw error
      }
    }
  }

  return {
    async publish(job, prioritize?: boolean) {
      const snsOverSqs: SNSOverSQSMessage = {
        Message: JSON.stringify(job)
      }

      const published = await sqs.sendMessage(
        {
          QueueUrl: prioritize && options.priorityQueueUrl ? options.priorityQueueUrl : options.queueUrl,
          MessageBody: JSON.stringify(snsOverSqs),
        }).promise()

      const m: TaskQueueMessage = { id: published.MessageId! }

      logger.info(`Publishing job`, m as any)

      components.metrics.increment('job_queue_enqueue_total', { queue_name: options.queueUrl })
      return m
    },
    async consumeAndProcessJob(taskRunner) {
      const normalQueueParams: AWS.SQS.ReceiveMessageRequest = {
        AttributeNames: ['SentTimestamp'],
        MaxNumberOfMessages: 1,
        MessageAttributeNames: ['All'],
        QueueUrl: options.queueUrl,
        WaitTimeSeconds: 15,
        VisibilityTimeout: 3 * 3600 // 3 hours
      }

      while (true) {
        try {
          let response
          
          if (options.priorityQueueUrl) {
            response = await Promise.race([
              sqs.receiveMessage({
                AttributeNames: ['SentTimestamp'],
                MaxNumberOfMessages: 1,
                MessageAttributeNames: ['All'],
                QueueUrl: options.priorityQueueUrl,
                WaitTimeSeconds: 15,
                VisibilityTimeout: 3 * 3600 // 3 hours
              }).promise(),
              timeout(30 * 60 * 1000, 'Timed out sqs.receiveMessage')
            ])
          }

          if (!response || !response?.Messages || response?.Messages?.length < 1) {
            response = await Promise.race([
              sqs.receiveMessage(normalQueueParams).promise(),
              timeout(30 * 60 * 1000, 'Timed out sqs.receiveMessage')
            ])
          }


          if (response.Messages && response.Messages.length > 0) {
            for (const it of response.Messages) {
              const message: TaskQueueMessage = { id: it.MessageId! }
              const { end } = components.metrics.startTimer('job_queue_duration_seconds', { queue_name: options.queueUrl })
              try {
                const snsOverSqs: SNSOverSQSMessage = JSON.parse(it.Body!)
                logger.info(`Processing job`, { id: message.id, message: snsOverSqs.Message })
                const result = await taskRunner(JSON.parse(snsOverSqs.Message), message)
                logger.info(`Processed job`, { id: message.id })
                return { result, message }
              } catch (err: any) {
                logger.error(err)

                components.metrics.increment('job_queue_failures_total', { queue_name: options.queueUrl })

                return { result: undefined, message }
              } finally {
                await removeMessageFromQueues(it.ReceiptHandle!, [options.queueUrl, options.priorityQueueUrl].filter((queue) => queue !== undefined))
                end()
              }
            }
          }
          logger.info(`No new messages in queue. Retrying for 15 seconds`)
        } catch (err: any) {
          logger.error(err)
          await sleep(1000)
        }
      }
    },
  }
}
