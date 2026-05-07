import { Lifecycle } from '@well-known-components/interfaces'
import { setupRouter } from './controllers/routes'
import { executeConversion, executeLODConversion, executeTriagePass, parseBooleanFlag } from './logic/conversion-task'
import checkDiskSpace from 'check-disk-space'
import { AppComponents, GlobalContext, TestComponents } from './types'
import { AssetBundleConversionFinishedEvent, Events } from '@dcl/schemas'
import { DeploymentToSqs } from '@dcl/schemas/dist/misc/deployments-to-sqs'
import { getAbVersionEnvName } from './utils'

type Platform = 'windows' | 'mac' | 'webgl'
type Logger = ReturnType<AppComponents['logs']['getLogger']>

// this function wires the business logic (adapters & controllers) with the components (ports)
export async function main(program: Lifecycle.EntryPointParameters<AppComponents | TestComponents>) {
  const { components, startComponents } = program
  const globalContext: GlobalContext = {
    components
  }

  // wire the HTTP router (make it automatic? TBD)
  const router = await setupRouter(globalContext)
  // register routes middleware
  components.server.use(router.middleware())
  // register not implemented/method not allowed/cors responses middleware
  components.server.use(router.allowedMethods())
  // set the context to be passed to the handlers
  components.server.setContext(globalContext)

  // start ports: db, listeners, synchronizations, etc
  await startComponents()

  const platform = (await components.config.requireString('PLATFORM')).toLocaleLowerCase() as Platform
  const $BUILD_TARGET = await components.config.requireString('BUILD_TARGET')
  const abVersionEnvName = getAbVersionEnvName($BUILD_TARGET)
  const $AB_VERSION = await components.config.requireString(abVersionEnvName)

  const triageLogger = components.logs.getLogger('triage-loop')
  const unityLogger = components.logs.getLogger('unity-loop')

  const triageEnabled = parseBooleanFlag(await components.config.getString('FAST_PATH_TRIAGE_ENABLED'), false, (raw) =>
    triageLogger.warn(
      `Unrecognized value for FAST_PATH_TRIAGE_ENABLED: "${raw}" — falling back to the default (false). Accepted values: true/false/1/0/yes/no/on/off.`
    )
  )

  // Triage loop. When `FAST_PATH_TRIAGE_ENABLED` is off (default), it behaves
  // exactly like today's single loop — pulls from the triage queue, runs full
  // executeConversion (Unity if needed), publishes the finished event, acks.
  // When on, runs only the probe portion via executeTriagePass; cache-miss
  // jobs are republished to the Unity queue and the Unity loop picks them up.
  components.runner.runTask(async (opt) => {
    while (opt.isRunning) {
      if (await machineRanOutOfSpace(components)) {
        triageLogger.warn('Stopping program due to lack of disk space')
        void program.stop()
        return
      }

      await components.triageTaskQueue.consumeAndProcessJob(async (job, _message, opts) => {
        await processIncomingJob({
          job,
          isPriority: opts.isPriority,
          components,
          platform,
          $BUILD_TARGET,
          $AB_VERSION,
          triageEnabled,
          logger: triageLogger
        })
      })
    }
  })

  // Unity loop. Always runs; drains the Unity queue regardless of the kill
  // switch. When the switch is off, no new messages land here (triage loop
  // calls executeConversion directly), so this loop sits idle. On revert,
  // any residual messages drain naturally.
  components.runner.runTask(async (opt) => {
    while (opt.isRunning) {
      if (await machineRanOutOfSpace(components)) {
        unityLogger.warn('Stopping program due to lack of disk space (unity loop)')
        void program.stop()
        return
      }

      await components.unityTaskQueue.consumeAndProcessJob(async (job, _message, _opts) => {
        await processUnityJob({
          job,
          components,
          platform,
          $AB_VERSION,
          logger: unityLogger
        })
      })
    }
  })
}

// Validates the shape of an incoming SQS job before either loop tries to
// process it. Logs and returns false for anything that's not a real
// conversion (e.g., world_undeployment events that leak into the SNS topic,
// or malformed payloads with empty `contentServerUrls`).
//
// LOD jobs are special: they're identified by a `lods` array and don't carry
// `contentServerUrls` — Unity reads the LOD GLBs directly from the LOD list,
// not from a content server. Don't gate them on contentServerUrls presence.
export function isValidConversionJob(job: DeploymentToSqs, logger: Logger): boolean {
  if (!job?.entity?.entityId) {
    logger.warn('Skipping job with no entity.entityId — not a conversion job', {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      type: (job as any)?.type,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      subType: (job as any)?.subType
    })
    return false
  }
  if (!job.lods && !job.contentServerUrls?.[0]) {
    // Non-LOD jobs MUST carry at least one content server URL — both the
    // probe (catalyst entity fetch) and Unity asset resolution need it.
    // Without this guard, the `[0]!` non-null assertion downstream produces
    // an `undefined` URL that fails opaquely deep inside fetch logic.
    logger.warn('Skipping job with no contentServerUrls — not a conversion job', {
      entityId: job.entity.entityId
    })
    return false
  }
  return true
}

type ProcessJobArgs = {
  job: DeploymentToSqs
  isPriority: boolean
  components: AppComponents | TestComponents
  platform: Platform
  $BUILD_TARGET: string
  $AB_VERSION: string
  triageEnabled: boolean
  logger: Logger
}

// Triage loop's per-message handler. Extracted to keep the runner body
// shallow and to share the validation guard between modes.
async function processIncomingJob(args: ProcessJobArgs): Promise<void> {
  const { job, isPriority, components, platform, $BUILD_TARGET, $AB_VERSION, triageEnabled, logger } = args

  if (!isValidConversionJob(job, logger)) return

  // Increment version if doISS is true (legacy v2004 path)
  const versionToUse = job.doISS ? 'v2004' : $AB_VERSION

  // LOD jobs always need Unity — they never fast-path.
  if (job.lods) {
    if (triageEnabled) {
      await republishToUnityQueue({ job, isPriority, components, $BUILD_TARGET, logger })
      return
    }
    await runFullConversionAndPublish({ job, components, platform, versionToUse, logger })
    return
  }

  if (!triageEnabled) {
    // Default behavior: run today's full executeConversion path inline.
    // running_conversion gauge is incremented inside runFullConversionAndPublish.
    await runFullConversionAndPublish({ job, components, platform, versionToUse, logger })
    return
  }

  // Fast-path triage mode. Track gauge so dashboards reflect "pod is busy
  // doing triage work" — distinct from running_conversion (which only
  // counts Unity-spawning work).
  components.metrics.increment('ab_converter_running_triage')
  try {
    const outcome = await executeTriagePass(
      components,
      job.entity.entityId,
      job.contentServerUrls![0],
      job.force,
      job.doISS,
      versionToUse
    )

    switch (outcome.kind) {
      case 'completed':
        // **Failure mode worth flagging**: if publishMessage throws (SNS
        // wedged), the SQS adapter's finally block deletes the triage
        // message anyway, so the finished event is silently lost. This
        // matches today's behavior in runFullConversionAndPublish — fixing
        // it requires task-queue contract changes to support nack
        // semantics. Out of scope here; covered by the existing
        // ab_converter_unity_queue_publish_errors_total alarm pattern.
        await publishFinishedEvent({ job, components, platform, versionToUse, statusCode: outcome.exitCode })
        return
      case 'failed':
        // Sentinel was uploaded by executeTriagePass; emit the finished event so
        // the publisher's downstream consumers see the failure status, then ack.
        await publishFinishedEvent({ job, components, platform, versionToUse, statusCode: outcome.exitCode })
        return
      case 'needs-unity':
        await republishToUnityQueue({ job, isPriority, components, $BUILD_TARGET, logger })
        return
    }
  } finally {
    components.metrics.decrement('ab_converter_running_triage')
  }
}

type ProcessUnityJobArgs = {
  job: DeploymentToSqs
  components: AppComponents | TestComponents
  platform: Platform
  $AB_VERSION: string
  logger: Logger
}

// Unity loop's per-message handler. Runs the full executeConversion (which
// re-runs the probe; if a peer pod canonicalized the missing assets in the
// meantime, this short-circuits via executeConversion's own fast path).
async function processUnityJob(args: ProcessUnityJobArgs): Promise<void> {
  const { job, components, platform, $AB_VERSION, logger } = args

  if (!isValidConversionJob(job, logger)) return

  const versionToUse = job.doISS ? 'v2004' : $AB_VERSION
  await runFullConversionAndPublish({ job, components, platform, versionToUse, logger })
}

type RunFullArgs = {
  job: DeploymentToSqs
  components: AppComponents | TestComponents
  platform: Platform
  versionToUse: string
  logger: Logger
}

async function runFullConversionAndPublish(args: RunFullArgs): Promise<void> {
  const { job, components, platform, versionToUse } = args
  let statusCode: number
  try {
    components.metrics.increment('ab_converter_running_conversion')
    if (job.lods) {
      statusCode = await executeLODConversion(components, job.entity.entityId, job.lods, versionToUse)
    } else {
      statusCode = await executeConversion(
        components,
        job.entity.entityId,
        job.contentServerUrls![0],
        job.force,
        job.animation,
        job.doISS,
        versionToUse
      )
    }
    // Same SNS-publish failure mode as the triage path — see comment in
    // processIncomingJob. A throw here means the SQS message is acked
    // without the finished event reaching downstream consumers.
    await publishFinishedEvent({ job, components, platform, versionToUse, statusCode })
  } finally {
    components.metrics.decrement('ab_converter_running_conversion')
  }
}

type PublishFinishedArgs = {
  job: DeploymentToSqs
  components: AppComponents | TestComponents
  platform: Platform
  versionToUse: string
  statusCode: number
}

async function publishFinishedEvent(args: PublishFinishedArgs): Promise<void> {
  const { job, components, platform, versionToUse, statusCode } = args
  const eventToPublish: AssetBundleConversionFinishedEvent = {
    type: Events.Type.ASSET_BUNDLE,
    subType: Events.SubType.AssetBundle.CONVERTED,
    key: `${job.entity.entityId}-${platform}`,
    timestamp: Date.now(),
    metadata: {
      platform: platform,
      entityId: job.entity.entityId,
      isLods: !!job.lods,
      isWorld:
        !!job.contentServerUrls &&
        job.contentServerUrls.length > 1 &&
        job.contentServerUrls[0].includes('worlds-content-server'),
      statusCode,
      version: versionToUse
    }
  }
  await components.publisher.publishMessage(eventToPublish)
}

type RepublishArgs = {
  job: DeploymentToSqs
  isPriority: boolean
  components: AppComponents | TestComponents
  $BUILD_TARGET: string
  logger: Logger
}

// **Lost-work warning**: the SQS adapter's consumeAndProcessJob deletes the
// triage message in its finally block (after this function throws or
// resolves), so a thrown error here means we acked the triage message
// without successfully republishing — work is permanently lost. This is a
// known limitation of the current task-queue contract (delete-in-finally),
// not introduced by the triage→Unity split.
//
// **Required ops gate before flipping FAST_PATH_TRIAGE_ENABLED=true**:
// configure an alert on `ab_converter_unity_queue_publish_errors_total > 0`
// with a low threshold (any non-zero rate is suspicious) so a wedged Unity
// queue is detected before significant backlog is lost. Throwing here also
// produces a loud error log keyed on entityId for incident triage.
async function republishToUnityQueue(args: RepublishArgs): Promise<void> {
  const { job, isPriority, components, $BUILD_TARGET, logger } = args
  try {
    await components.unityTaskQueue.publish(job, isPriority)
    components.metrics.increment('ab_converter_unity_queue_publish_total', {
      build_target: $BUILD_TARGET,
      priority: isPriority ? 'priority' : 'standard'
    })
  } catch (err: any) {
    logger.error(`Failed to republish job to Unity queue — work will be lost: ${err?.message ?? err}`, {
      entityId: job?.entity?.entityId
    })
    components.metrics.increment('ab_converter_unity_queue_publish_errors_total', {
      build_target: $BUILD_TARGET
    })
    throw err
  }
}

async function machineRanOutOfSpace(components: Pick<AppComponents, 'metrics'>) {
  const diskUsage = await checkDiskSpace('/')
  const free = diskUsage.free

  components.metrics.observe('ab_converter_free_disk_space', {}, free)

  if (free / 1e9 < 1 /* less than 1gb */) {
    return true
  }

  return false
}
