import { IBaseComponent } from '@well-known-components/interfaces'
import { validateMetricsDeclaration } from '@well-known-components/metrics'
import { AsyncQueue } from '@well-known-components/pushable-channel'
import { SQS } from 'aws-sdk'
import { AppComponents } from '../types'

export interface TaskQueueMessage {
  id: string
}

export interface ITaskQueue<T> {
  // publishes a job for the queue
  publish(job: T): Promise<TaskQueueMessage>
  // awaits for a job. then calls and waits for the taskRunner argument.
  // the result is then returned to the wrapper function.
  consumeAndProcessJob<R>(taskRunner: (job: T, message: TaskQueueMessage) => Promise<R>): Promise<{ result: R | undefined }>
}

export const queueMetrics = validateMetricsDeclaration({
  job_queue_duration_seconds: {
    type: "histogram",
    help: 'Duration of each job in seconds',
    labelNames: ["queue_name"],
  },
  job_queue_enqueue_total: {
    type: "counter",
    help: "Total amount of enqueued jobs",
    labelNames: ["queue_name"],
  },
  job_queue_failures_total: {
    type: "counter",
    help: "Total amount of failed tasks",
    labelNames: ["queue_name"],
  },
} as const)

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


export function createSqsAdapter<T>(components: Pick<AppComponents, "logs" | 'metrics'>, options: { queueUrl: string, queueRegion?: string }): ITaskQueue<T> {
  const logger = components.logs.getLogger(options.queueUrl)

  const sqs = new SQS({ apiVersion: 'latest', region: options.queueRegion })

  return {
    async publish(job) {
      const snsOverSqs: SNSOverSQSMessage = {
        Message: JSON.stringify(job)
      }

      const published = await sqs.sendMessage(
        {
          QueueUrl: options.queueUrl,
          MessageBody: JSON.stringify(snsOverSqs),
        }).promise()

      const m: TaskQueueMessage = { id: published.MessageId! }

      logger.info(`Publishing job`, m as any)

      components.metrics.increment('job_queue_enqueue_total', { queue_name: options.queueUrl })
      return m
    },
    async consumeAndProcessJob(taskRunner) {
      while (true) {
        const params: AWS.SQS.ReceiveMessageRequest = {
          AttributeNames: ['SentTimestamp'],
          MaxNumberOfMessages: 1,
          MessageAttributeNames: ['All'],
          QueueUrl: options.queueUrl,
          WaitTimeSeconds: 15,
        }

        const response = await sqs.receiveMessage(params).promise()
        if (response.Messages && response.Messages.length > 0) {
          for (const it of response.Messages) {
            const message: TaskQueueMessage = { id: it.MessageId! }
            const { end } = components.metrics.startTimer('job_queue_duration_seconds', { queue_name: options.queueUrl })
            try {
              const snsOverSqs: SNSOverSQSMessage = JSON.parse(it.Body!)
              logger.info(`Processing job`, { ...message, ...snsOverSqs } as any)
              const result = await taskRunner(JSON.parse(snsOverSqs.Message), message)
              logger.info(`Processed job`, message as any)
              return { result, message }
            } catch (err: any) {
              components.metrics.increment('job_queue_failures_total', { queue_name: options.queueUrl })
              logger.error(err)

              return { result: undefined, message }
            } finally {
              await sqs.deleteMessage({ QueueUrl: options.queueUrl, ReceiptHandle: it.ReceiptHandle! }).promise()
              end()
            }
          }
        }

        logger.info(`No new messages in queue. Retrying for 15 seconds`)
      }
    },
  }
}