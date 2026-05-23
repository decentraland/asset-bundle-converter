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
import { createFilesystemComponent } from './adapters/filesystem'
import { createCatalystComponent } from './adapters/catalyst'
import { createUnityRunnerComponent } from './adapters/unity-runner'
import { createRedisComponent } from '@dcl/redis-component'
import { createInMemoryCacheComponent } from '@dcl/memory-cache-component'
import { ICacheStorageComponent } from '@dcl/core-commons'
import { createConversionOrchestratorComponent } from './logic/conversion-orchestrator'
import { createScenesComponent } from './logic/scenes'
import { parseBooleanFlag } from './logic/conversion-task'

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

  const taskQueueUrl = await config.getString('TASK_QUEUE')
  const priorityTaskQueueUrl = await config.getString('PRIORITY_TASK_QUEUE')
  const triageTaskQueue = taskQueueUrl
    ? createSqsAdapter<DeploymentToSqs>(
        { logs, metrics },
        { queueUrl: taskQueueUrl, priorityQueueUrl: priorityTaskQueueUrl, queueRegion: AWS_REGION }
      )
    : createMemoryQueueAdapter<DeploymentToSqs>({ logs, metrics }, { queueName: 'TriageTaskQueue' })

  // Conversion queue is internal — only populated by the triage loop's
  // republish path. Falls back to a memory queue when env vars are unset
  // (local dev, pre-rollout deploys). The conversion loop drains whatever
  // lands here.
  const conversionTaskQueueUrl = await config.getString('CONVERSION_TASK_QUEUE')
  const conversionPriorityTaskQueueUrl = await config.getString('CONVERSION_PRIORITY_TASK_QUEUE')

  // Misconfiguration guards. The kill-switch is read again in the orchestrator
  // factory, so behaviour stays consistent; reading here lets us fail fast at
  // startup instead of silently dropping work into an in-memory queue.
  const startupLogger = logs.getLogger('startup-guard')
  const fastPathTriageEnabled = parseBooleanFlag(await config.getString('FAST_PATH_TRIAGE_ENABLED'), false, (raw) =>
    startupLogger.warn(
      `Unrecognized value for FAST_PATH_TRIAGE_ENABLED: "${raw}" — falling back to the default (false).`
    )
  )
  if (fastPathTriageEnabled && !conversionTaskQueueUrl) {
    throw new Error(
      'FAST_PATH_TRIAGE_ENABLED=true but CONVERSION_TASK_QUEUE is unset. Refusing to start: triage republishes would land in an in-memory queue, breaking cross-pod load balancing and losing work on restart. Configure CONVERSION_TASK_QUEUE (and CONVERSION_PRIORITY_TASK_QUEUE) before enabling fast-path triage.'
    )
  }
  if (conversionTaskQueueUrl && !conversionPriorityTaskQueueUrl) {
    // Not fatal — the SQS adapter silently drops priority republishes onto the
    // standard queue, which degrades priority lane separation but keeps work
    // moving. Warn so the misconfiguration surfaces in logs.
    startupLogger.warn(
      'CONVERSION_TASK_QUEUE is set but CONVERSION_PRIORITY_TASK_QUEUE is not. Priority-lane jobs republished from triage will land on the standard Conversion queue.'
    )
  }

  const conversionTaskQueue = conversionTaskQueueUrl
    ? createSqsAdapter<DeploymentToSqs>(
        { logs, metrics },
        {
          queueUrl: conversionTaskQueueUrl,
          priorityQueueUrl: conversionPriorityTaskQueueUrl,
          queueRegion: AWS_REGION
        }
      )
    : createMemoryQueueAdapter<DeploymentToSqs>({ logs, metrics }, { queueName: 'ConversionTaskQueue' })

  const s3Bucket = await config.getString('CDN_BUCKET')
  const cdnS3 = s3Bucket ? new AWS.S3({}) : new MockAws.S3({})

  const runner = createRunnerComponent()
  const publisher = await createSnsComponent({ config, logs })
  const filesystem = await createFilesystemComponent({ metrics })
  const catalyst = await createCatalystComponent({ fetch })
  const unityRunner = await createUnityRunnerComponent({ logs, metrics })

  // Cache component for the asset probe layer (see logic/asset-reuse.ts).
  // Prefers Redis when REDIS_URL is configured so probe hits are shared across
  // pods; falls back to an in-process LRU when unset (local dev, pre-rollout)
  // so the same code path works without standing up a Redis instance. Both
  // implementations satisfy `ICacheStorageComponent` from @dcl/core-commons,
  // so call sites are unaware of which one is wired in.
  const redisUrl = await config.getString('REDIS_URL')
  let redis: ICacheStorageComponent
  if (redisUrl) {
    redis = await createRedisComponent(redisUrl, { logs })
  } else {
    logs.getLogger('cache').info('REDIS_URL not set — using in-memory cache (no cross-pod sharing)')
    redis = createInMemoryCacheComponent()
  }

  const scenes = await createScenesComponent({ logs, config, metrics, cdnS3, sentry, catalyst, redis })
  const conversionOrchestrator = await createConversionOrchestratorComponent({
    logs,
    metrics,
    config,
    cdnS3,
    sentry,
    conversionTaskQueue,
    publisher,
    catalyst,
    unityRunner,
    scenes
  })

  return {
    config,
    logs,
    server,
    statusChecks,
    fetch,
    metrics,
    triageTaskQueue,
    conversionTaskQueue,
    cdnS3,
    runner,
    sentry,
    publisher,
    filesystem,
    catalyst,
    unityRunner,
    redis,
    scenes,
    conversionOrchestrator
  }
}
