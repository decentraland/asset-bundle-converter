import { createDotEnvConfigComponent } from '@well-known-components/env-config-provider'
import {
  createServerComponent,
  createStatusCheckComponent,
  instrumentHttpServerWithPromClientRegistry
} from '@dcl/http-server'
import { createLogComponent } from '@well-known-components/logger'
import { createFetchComponent } from './adapters/fetch'
import { createMetricsComponent } from '@dcl/metrics'
import type { IConfigComponent } from '@well-known-components/interfaces'
import { createSqsComponent } from '@dcl/sqs-component'
import { createMemoryQueueComponent } from '@dcl/memory-queue-component'
import type { IQueueComponent } from '@dcl/core-commons'
import { AppComponents, GlobalContext } from './types'
import { metricDeclarations } from './metrics'
import AWS from 'aws-sdk'
import MockAws from 'mock-aws-s3'
import { createTaskQueueAdapter } from './adapters/task-queue'
import { DeploymentToSqs } from '@dcl/schemas/dist/misc/deployments-to-sqs'
import { createRunnerComponent } from './adapters/runner'
import { createSentryComponent } from './adapters/sentry'
import { createSnsComponent } from './adapters/sns'

// `@dcl/sqs-component`'s factory reads its target queue URL from the
// `AWS_SQS_QUEUE_URL` config key once at construction time. We keep the
// existing `TASK_QUEUE` / `PRIORITY_TASK_QUEUE` env var names to avoid a
// deploy-time rename and synthesize a one-off config per queue so we can
// spin up one `@dcl/sqs-component` per URL.
function syntheticQueueConfig(
  parent: IConfigComponent,
  queueUrl: string,
  endpoint: string | undefined
): IConfigComponent {
  const overrides: Record<string, string | undefined> = {
    AWS_SQS_QUEUE_URL: queueUrl,
    AWS_SQS_ENDPOINT: endpoint
  }
  return {
    async getString(key) {
      return key in overrides ? overrides[key] : parent.getString(key)
    },
    async requireString(key) {
      if (key in overrides) {
        const v = overrides[key]
        if (!v) throw new Error(`config ${key} is required`)
        return v
      }
      return parent.requireString(key)
    },
    async getNumber(key) {
      return parent.getNumber(key)
    },
    async requireNumber(key) {
      return parent.requireNumber(key)
    }
  }
}

// Initialize all the components of the app
export async function initComponents(): Promise<AppComponents> {
  const config = await createDotEnvConfigComponent({ path: ['.env.default', '.env'] })

  const sentry = await createSentryComponent({ config })

  const AWS_REGION = await config.getString('AWS_REGION')
  if (AWS_REGION) {
    AWS.config.update({ region: AWS_REGION })
  }

  const metrics = await createMetricsComponent(metricDeclarations, { config })
  const logs = await createLogComponent({ metrics })
  const server = await createServerComponent<GlobalContext>(
    { config, logs },
    {
      cors: {
        methods: ['GET', 'HEAD', 'OPTIONS', 'DELETE', 'POST', 'PUT'],
        maxAge: 86400
      }
    }
  )
  const statusChecks = await createStatusCheckComponent({ server, config })
  const fetch = await createFetchComponent()

  await instrumentHttpServerWithPromClientRegistry({ metrics, server, config, registry: metrics.registry! })

  const sqsQueueUrl = await config.getString('TASK_QUEUE')
  const priorityQueueUrl = await config.getString('PRIORITY_TASK_QUEUE')
  const sqsEndpoint = await config.getString('AWS_SQS_ENDPOINT')

  let mainQueue: IQueueComponent
  let priorityQueue: IQueueComponent | undefined
  let adapterWaitTimeSeconds: number
  if (sqsQueueUrl) {
    mainQueue = await createSqsComponent(syntheticQueueConfig(config, sqsQueueUrl, sqsEndpoint))
    priorityQueue = priorityQueueUrl
      ? await createSqsComponent(syntheticQueueConfig(config, priorityQueueUrl, sqsEndpoint))
      : undefined
    // 15s matches the long-poll the legacy aws-sdk adapter used; SQS clamps
    // `WaitTimeSeconds` at 20.
    adapterWaitTimeSeconds = 15
  } else {
    // In-memory fallback — exercised by tests and local dev. `waitTimeSeconds`
    // here becomes the inter-poll sleep inside `@dcl/memory-queue-component`,
    // so keep it small so that `runner.stop()` (which awaits in-flight
    // `consumeAndProcessJob` calls) doesn't block the test teardown for the
    // production long-poll window.
    mainQueue = createMemoryQueueComponent()
    priorityQueue = undefined
    adapterWaitTimeSeconds = 0.1
  }

  const taskQueue = createTaskQueueAdapter<DeploymentToSqs>(
    { logs, metrics },
    {
      queueName: sqsQueueUrl ?? 'ConversionTaskQueue',
      main: mainQueue,
      priority: priorityQueue,
      waitTimeSeconds: adapterWaitTimeSeconds
    }
  )

  const s3Bucket = await config.getString('CDN_BUCKET')
  const cdnS3 = s3Bucket ? new AWS.S3({}) : new MockAws.S3({})

  const runner = createRunnerComponent()
  const publisher = await createSnsComponent({ config, logs })

  return {
    config,
    logs,
    server,
    statusChecks,
    fetch,
    metrics,
    taskQueue,
    cdnS3,
    runner,
    sentry,
    publisher
  }
}
