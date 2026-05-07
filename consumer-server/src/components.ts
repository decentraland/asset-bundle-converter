import { createDotEnvConfigComponent } from '@well-known-components/env-config-provider'
import {
  createServerComponent,
  createStatusCheckComponent,
  instrumentHttpServerWithPromClientRegistry
} from '@well-known-components/http-server'
import { createLogComponent } from '@well-known-components/logger'
import { createFetchComponent } from './adapters/fetch'
import { createMetricsComponent } from '@well-known-components/metrics'
import { AppComponents, GlobalContext } from './types'
import { metricDeclarations } from './metrics'
import AWS from 'aws-sdk'
import MockAws from 'mock-aws-s3'
import { createMemoryQueueAdapter, createSqsAdapter } from './adapters/task-queue'
import { DeploymentToSqs } from '@dcl/schemas/dist/misc/deployments-to-sqs'
import { createRunnerComponent } from './adapters/runner'
import { createSentryComponent } from './adapters/sentry'
import { createSnsComponent } from './adapters/sns'

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

  const sqsQueue = await config.getString('TASK_QUEUE')
  const priorityQueue = await config.getString('PRIORITY_TASK_QUEUE')
  const triageTaskQueue = sqsQueue
    ? createSqsAdapter<DeploymentToSqs>(
        { logs, metrics },
        { queueUrl: sqsQueue, priorityQueueUrl: priorityQueue, queueRegion: AWS_REGION }
      )
    : createMemoryQueueAdapter<DeploymentToSqs>({ logs, metrics }, { queueName: 'TriageTaskQueue' })

  // Unity queue is internal — only populated by the triage loop's republish
  // path. Falls back to a memory queue when env vars are unset (local dev,
  // pre-rollout deploys). The Unity loop drains whatever lands here.
  const unitySqsQueue = await config.getString('UNITY_TASK_QUEUE')
  const unityPriorityQueue = await config.getString('UNITY_PRIORITY_TASK_QUEUE')
  const unityTaskQueue = unitySqsQueue
    ? createSqsAdapter<DeploymentToSqs>(
        { logs, metrics },
        { queueUrl: unitySqsQueue, priorityQueueUrl: unityPriorityQueue, queueRegion: AWS_REGION }
      )
    : createMemoryQueueAdapter<DeploymentToSqs>({ logs, metrics }, { queueName: 'UnityTaskQueue' })

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
    triageTaskQueue,
    unityTaskQueue,
    cdnS3,
    runner,
    sentry,
    publisher
  }
}
