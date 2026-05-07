import type {
  IConfigComponent,
  ILoggerComponent,
  IHttpServerComponent,
  IBaseComponent,
  IMetricsComponent,
  IFetchComponent
} from '@well-known-components/interfaces'
import { metricDeclarations } from './metrics'
import { ITaskQueue } from './adapters/task-queue'
import { DeploymentToSqs } from '@dcl/schemas/dist/misc/deployments-to-sqs'
import { S3 } from 'aws-sdk'
import { IRunnerComponent } from './adapters/runner'
import { SentryComponent } from './adapters/sentry'
import { AssetBundleConversionFinishedEvent, AssetBundleConversionManuallyQueuedEvent } from '@dcl/schemas'

export type GlobalContext = {
  components: BaseComponents
}

// components used in every environment
export type BaseComponents = {
  config: IConfigComponent
  logs: ILoggerComponent
  server: IHttpServerComponent<GlobalContext>
  fetch: IFetchComponent
  // Triage queue: receives messages from the SNS deployments topic. The triage
  // loop pulls from here, runs the probe, fast-paths on full cache hit, and
  // republishes cache-miss messages to `unityTaskQueue`.
  triageTaskQueue: ITaskQueue<DeploymentToSqs>
  // Unity queue: populated only by the triage loop via SendMessage. The Unity
  // loop drains it and runs the full conversion (which re-runs the probe for
  // safety). Always wired even when FAST_PATH_TRIAGE_ENABLED is off, so any
  // residual messages drain naturally on revert.
  unityTaskQueue: ITaskQueue<DeploymentToSqs>
  metrics: IMetricsComponent<keyof typeof metricDeclarations>
  cdnS3: S3
  runner: IRunnerComponent
  sentry: SentryComponent
  publisher: PublisherComponent
}

// components used in runtime
export type AppComponents = BaseComponents & {
  statusChecks: IBaseComponent
}

// components used in tests
export type TestComponents = BaseComponents & {
  // A fetch component that only hits the test server
  localFetch: IFetchComponent
}

// this type simplifies the typings of http handlers
export type HandlerContextWithPath<
  ComponentNames extends keyof AppComponents,
  Path extends string = any
> = IHttpServerComponent.PathAwareContext<
  IHttpServerComponent.DefaultContext<{
    components: Pick<AppComponents, ComponentNames>
  }>,
  Path
>

export type Context<Path extends string = any> = IHttpServerComponent.PathAwareContext<GlobalContext, Path>

export type PublisherComponent = {
  publishMessage(event: AssetBundleConversionFinishedEvent | AssetBundleConversionManuallyQueuedEvent): Promise<void>
}
