import { createDotEnvConfigComponent } from "@well-known-components/env-config-provider"
import { createServerComponent, createStatusCheckComponent } from "@well-known-components/http-server"
import { createLogComponent } from "@well-known-components/logger"
import { createFetchComponent } from "./adapters/fetch"
import { createMetricsComponent, instrumentHttpServerWithMetrics } from "@well-known-components/metrics"
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
  const server = await createServerComponent<GlobalContext>({ config, logs }, {})
  const statusChecks = await createStatusCheckComponent({ server, config })
  const fetch = await createFetchComponent()

  await instrumentHttpServerWithMetrics({ metrics, server, config })

  const sqsQueue = await config.getString('TASK_QUEUE')
  const taskQueue = sqsQueue ?
  createSqsAdapter<DeploymentToSqs & { lods: string[] | undefined }>({ logs, metrics }, { queueUrl: sqsQueue, queueRegion: AWS_REGION }) :
  createMemoryQueueAdapter<DeploymentToSqs & { lods: string[] | undefined }>({ logs, metrics }, { queueName: "ConversionTaskQueue" })
  
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
