import { AssetBundleConversionFinishedEvent, Events } from '@dcl/schemas'
import { DeploymentToSqs } from '@dcl/schemas/dist/misc/deployments-to-sqs'
import { AppComponents, TestComponents } from '../../types'
import { getAbVersionEnvName } from '../../utils'
import { executeConversion, executeLODConversion, executeTriagePass, parseBooleanFlag } from '../conversion-task'
import { UnityQueueRepublishFailedError } from './errors'
import type { IConversionOrchestratorComponent, Platform } from './types'

type Components = Pick<
  AppComponents | TestComponents,
  'logs' | 'metrics' | 'config' | 'cdnS3' | 'sentry' | 'unityTaskQueue' | 'publisher'
>

export async function createConversionOrchestratorComponent(
  components: Components
): Promise<IConversionOrchestratorComponent> {
  const { logs, metrics, config, unityTaskQueue, publisher } = components
  const logger = logs.getLogger('conversion-orchestrator')

  const platform = (await config.requireString('PLATFORM')).toLocaleLowerCase() as Platform
  const buildTarget = await config.requireString('BUILD_TARGET')
  const abVersion = await config.requireString(getAbVersionEnvName(buildTarget))
  const triageEnabled = parseBooleanFlag(await config.getString('FAST_PATH_TRIAGE_ENABLED'), false, (raw) =>
    logger.warn(
      `Unrecognized value for FAST_PATH_TRIAGE_ENABLED: "${raw}" — falling back to the default (false). Accepted values: true/false/1/0/yes/no/on/off.`
    )
  )

  // Validates the shape of an incoming SQS job before either loop tries to
  // process it. Logs and returns false for anything that's not a real
  // conversion (e.g., world_undeployment events that leak into the SNS topic,
  // or malformed payloads with empty `contentServerUrls`).
  //
  // LOD jobs are special: they're identified by a `lods` array and don't carry
  // `contentServerUrls` — Unity reads the LOD GLBs directly from the LOD list,
  // not from a content server. Don't gate them on contentServerUrls presence.
  function isValidConversionJob(job: DeploymentToSqs): boolean {
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

  async function publishFinishedEvent(job: DeploymentToSqs, statusCode: number, versionToUse: string): Promise<void> {
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
    await publisher.publishMessage(eventToPublish)
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
  async function republishToUnityQueue(job: DeploymentToSqs, isPriority: boolean): Promise<void> {
    try {
      await unityTaskQueue.publish(job, isPriority)
      metrics.increment('ab_converter_unity_queue_publish_total', {
        build_target: buildTarget,
        priority: isPriority ? 'priority' : 'standard'
      })
    } catch (err: any) {
      logger.error(`Failed to republish job to Unity queue — work will be lost: ${err?.message ?? err}`, {
        entityId: job?.entity?.entityId
      })
      metrics.increment('ab_converter_unity_queue_publish_errors_total', {
        build_target: buildTarget
      })
      throw new UnityQueueRepublishFailedError(job.entity.entityId, buildTarget, err)
    }
  }

  async function runFullConversionAndPublish(job: DeploymentToSqs, versionToUse: string): Promise<void> {
    let statusCode: number
    try {
      metrics.increment('ab_converter_running_conversion')
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
      await publishFinishedEvent(job, statusCode, versionToUse)
    } finally {
      metrics.decrement('ab_converter_running_conversion')
    }
  }

  return {
    async processIncomingJob(job, isPriority) {
      if (!isValidConversionJob(job)) return

      // Increment version if doISS is true (legacy v2004 path)
      const versionToUse = job.doISS ? 'v2004' : abVersion

      // LOD jobs always need Unity — they never fast-path.
      if (job.lods) {
        if (triageEnabled) {
          await republishToUnityQueue(job, isPriority)
          return
        }
        await runFullConversionAndPublish(job, versionToUse)
        return
      }

      if (!triageEnabled) {
        // Default behavior: run today's full executeConversion path inline.
        // running_conversion gauge is incremented inside runFullConversionAndPublish.
        await runFullConversionAndPublish(job, versionToUse)
        return
      }

      // Fast-path triage mode. Track gauge so dashboards reflect "pod is busy
      // doing triage work" — distinct from running_conversion (which only
      // counts Unity-spawning work).
      metrics.increment('ab_converter_running_triage')
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
            await publishFinishedEvent(job, outcome.exitCode, versionToUse)
            return
          case 'failed':
            // Sentinel was uploaded by executeTriagePass; emit the finished event so
            // the publisher's downstream consumers see the failure status, then ack.
            await publishFinishedEvent(job, outcome.exitCode, versionToUse)
            return
          case 'needs-unity':
            await republishToUnityQueue(job, isPriority)
            return
        }
      } finally {
        metrics.decrement('ab_converter_running_triage')
      }
    },

    async processUnityJob(job) {
      if (!isValidConversionJob(job)) return
      const versionToUse = job.doISS ? 'v2004' : abVersion
      await runFullConversionAndPublish(job, versionToUse)
    }
  }
}
