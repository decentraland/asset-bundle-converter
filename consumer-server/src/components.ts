import { createDotEnvConfigComponent } from "@well-known-components/env-config-provider"
import { createServerComponent, createStatusCheckComponent, instrumentHttpServerWithPromClientRegistry } from "@well-known-components/http-server"
import { createLogComponent } from "@well-known-components/logger"
import { createFetchComponent } from "./adapters/fetch"
import { createMetricsComponent } from "@well-known-components/metrics"
import { AppComponents, GlobalContext } from "./types"
import { metricDeclarations } from "./metrics"
import AWS from "aws-sdk"
import MockAws from "mock-aws-s3"
import { createMemoryQueueAdapter, createSqsAdapter } from "./adapters/task-queue"
import { DeploymentToSqs } from "@dcl/schemas/dist/misc/deployments-to-sqs"
import { createRunnerComponent } from "./adapters/runner"

// Initialize all the components of the app
export async function initComponents(): Promise<AppComponents> {
  const config = await createDotEnvConfigComponent({ path: [".env.default", ".env"] })

  const AWS_REGION = await config.getString('AWS_REGION')
  if (AWS_REGION) {
    AWS.config.update({ region: AWS_REGION })
  }

  const metrics = await createMetricsComponent(metricDeclarations, { config })
  const logs = await createLogComponent({ metrics })
  const server = await createServerComponent<GlobalContext>({ config, logs }, {
    cors: {
      methods: ['GET', 'HEAD', 'OPTIONS', 'DELETE', 'POST', 'PUT'],
      maxAge: 86400
    }
  })
  const statusChecks = await createStatusCheckComponent({ server, config })
  const fetch = await createFetchComponent()

  await instrumentHttpServerWithPromClientRegistry({ metrics, server, config, registry: metrics.registry! })

  const sqsQueue = await config.getString('TASK_QUEUE')
  const priorityQueue = await config.getString('PRIORITY_TASK_QUEUE')
  const taskQueue = sqsQueue ?
  createSqsAdapter<DeploymentToSqs>({ logs, metrics }, { queueUrl: sqsQueue, priorityQueueUrl: priorityQueue, queueRegion: AWS_REGION }) :
  createMemoryQueueAdapter<DeploymentToSqs>({ logs, metrics }, { queueName: "ConversionTaskQueue" })

  const s3Bucket = await config.getString('CDN_BUCKET')
  const cdnS3 = s3Bucket ? new AWS.S3({}) : new MockAws.S3({})

  const runner = createRunnerComponent()

  return {
    config,
    logs,
    server,
    statusChecks,
    fetch,
    metrics,
    taskQueue,
    cdnS3,
    runner
  }
}
