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
import { IFilesystemComponent } from './adapters/filesystem'
import { ICatalystComponent } from './adapters/catalyst'
import { IUnityRunnerComponent } from './adapters/unity-runner'
import { IConversionOrchestratorComponent } from './logic/conversion-orchestrator'
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
  // Wraps `check-disk-space`. The consumer loops poll `isBelowMinimum()` to
  // gracefully stop accepting new jobs when the host disk is about to fill.
  filesystem: IFilesystemComponent
  // HTTP client for catalysts and worlds-content-server. All conversion I/O
  // against the catalyst funnels through this so tests can inject a fake.
  catalyst: ICatalystComponent
  // Spawns the Unity child process for scene / wearable / LOD conversions.
  // Owns the spawn, timeout, log streaming, and CLI-arg validation logic.
  unityRunner: IUnityRunnerComponent
  // Per-message decision tree for both consumer loops (triage + Unity).
  // Owns the validation guard, fast-path / republish routing, and the
  // finished-event publication. Constructed at startup with config-derived
  // settings (build target, AB version, kill switch).
  conversionOrchestrator: IConversionOrchestratorComponent
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
