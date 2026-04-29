import { IMetricsComponent } from '@well-known-components/interfaces'
import { validateMetricsDeclaration } from '@dcl/metrics'
import type { IQueueComponent } from '@dcl/core-commons'
import { AppComponents } from '../types'

export interface TaskQueueMessage {
  id: string
}

export interface ITaskQueue<T> {
  // publishes a job for the queue
  publish(job: T, prioritize?: boolean): Promise<TaskQueueMessage>
  // awaits for a job. then calls and waits for the taskRunner argument.
  // the result is then returned to the wrapper function.
  consumeAndProcessJob<R>(
    taskRunner: (job: T, message: TaskQueueMessage) => Promise<R>
  ): Promise<{ result: R | undefined }>
}

export const queueMetrics = validateMetricsDeclaration({
  job_queue_duration_seconds: {
    type: IMetricsComponent.HistogramType,
    help: 'Duration of each job in seconds',
    labelNames: ['queue_name'],
    buckets: [1, 10, 100, 200, 300, 400, 500, 600, 700, 1000, 1200, 1600, 1800, 3600]
  },
  job_queue_enqueue_total: {
    type: IMetricsComponent.CounterType,
    help: 'Total amount of enqueued jobs',
    labelNames: ['queue_name']
  },
  job_queue_failures_total: {
    type: IMetricsComponent.CounterType,
    help: 'Total amount of failed tasks',
    labelNames: ['queue_name']
  }
})

// SNS-over-SQS envelope: `@dcl/sqs-component` and `@dcl/memory-queue-component`
// both wrap `sendMessage(x)` as `{ Body: JSON.stringify({ Message: JSON.stringify(x) }) }`
// by default (preserving the existing SNS-subscription shape). We unwrap it on
// receive so downstream code still sees a plain `DeploymentToSqs` payload.
type SNSOverSQSMessage = { Message: string }

export type TaskQueueOptions = {
  // Label used in logs and the prom metric `queue_name` dimension.
  queueName: string
  main: IQueueComponent
  // Optional secondary queue polled first on each tick; callers signal intent
  // via `publish(job, prioritize=true)`.
  priority?: IQueueComponent
  // Unity conversions can run tens of minutes; set well above the longest
  // expected job so a single worker drains one message at a time without it
  // silently reappearing on another consumer mid-run.
  visibilityTimeoutSeconds?: number
  // Long-poll window handed to the underlying queue. For SQS this becomes the
  // `WaitTimeSeconds` of `ReceiveMessage`; for the in-memory queue it's the
  // sleep-between-polls. Lower values mean faster shutdown, higher values mean
  // fewer empty receives.
  waitTimeSeconds?: number
}

/**
 * Wraps one (or two, when priority is configured) `IQueueComponent`s in the
 * `ITaskQueue` interface consumed by `service.ts` and `queueTaskHandler`.
 *
 * `consumeAndProcessJob` returns after each receive cycle (whether a message
 * was handled or not), so the runner's `while (opt.isRunning)` loop can
 * observe a shutdown flag and exit cooperatively within one
 * `waitTimeSeconds` window — unlike the previous hand-rolled SQS loop, which
 * ran an inner `while (true)` with no shutdown escape (see the earlier
 * shutdown-mechanics audit, gaps #1 and #2).
 */
export function createTaskQueueAdapter<T>(
  components: Pick<AppComponents, 'logs' | 'metrics'>,
  options: TaskQueueOptions
): ITaskQueue<T> {
  const { queueName, main, priority } = options
  // 3 hours — Unity conversions can legitimately run that long, so the
  // message must stay invisible to other consumers for at least that window.
  // Matches the value the legacy aws-sdk adapter used.
  const visibilityTimeout = options.visibilityTimeoutSeconds ?? 3 * 3600
  const waitTimeSeconds = options.waitTimeSeconds ?? 15
  const logger = components.logs.getLogger(queueName)

  async function receiveFromEither(): Promise<{ msg: any; queue: IQueueComponent } | null> {
    if (priority) {
      const msgs = await priority.receiveMessages(1, { visibilityTimeout, waitTimeSeconds })
      if (msgs.length > 0) return { msg: msgs[0], queue: priority }
    }
    const msgs = await main.receiveMessages(1, { visibilityTimeout, waitTimeSeconds })
    if (msgs.length > 0) return { msg: msgs[0], queue: main }
    return null
  }

  return {
    async publish(job, prioritize) {
      const target = prioritize && priority ? priority : main
      await target.sendMessage(job)
      components.metrics.increment('job_queue_enqueue_total', { queue_name: queueName })
      // `IQueueComponent.sendMessage` returns void, so the real SQS MessageId
      // isn't available here. The id is only surfaced through the HTTP
      // /queue-task response; synthesize a process-unique tag good enough
      // for log correlation.
      const id = `job-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
      const message: TaskQueueMessage = { id }
      logger.info('Publishing job', { id })
      return message
    },
    async consumeAndProcessJob(taskRunner) {
      let received: { msg: any; queue: IQueueComponent } | null
      try {
        received = await receiveFromEither()
      } catch (err: any) {
        logger.error(err)
        return { result: undefined }
      }
      if (!received) {
        return { result: undefined }
      }
      const { msg, queue } = received
      const taskMessage: TaskQueueMessage = { id: msg.MessageId }
      const { end } = components.metrics.startTimer('job_queue_duration_seconds', { queue_name: queueName })
      try {
        const snsOverSqs: SNSOverSQSMessage = JSON.parse(msg.Body)
        logger.info('Processing job', { id: taskMessage.id, message: snsOverSqs.Message })
        const result = await taskRunner(JSON.parse(snsOverSqs.Message), taskMessage)
        logger.info('Processed job', { id: taskMessage.id })
        return { result }
      } catch (err: any) {
        components.metrics.increment('job_queue_failures_total', { queue_name: queueName })
        logger.error(err, { id: taskMessage.id })
        return { result: undefined }
      } finally {
        try {
          await queue.deleteMessage(msg.ReceiptHandle)
        } catch (err: any) {
          logger.error('Failed to delete message after processing', { id: taskMessage.id, error: err?.message })
        }
        end()
      }
    }
  }
}
