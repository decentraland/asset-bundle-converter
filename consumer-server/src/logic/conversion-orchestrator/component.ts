import { AssetBundleConversionFinishedEvent, Events } from '@dcl/schemas'
import { DeploymentToSqs } from '@dcl/schemas/dist/misc/deployments-to-sqs'
import { AppComponents, TestComponents } from '../../types'
import { getAbVersionEnvName } from '../../utils'
import { executeConversion, executeLODConversion, executeTriagePass, parseBooleanFlag } from '../conversion-task'
import { ConversionQueueRepublishFailedError } from './errors'
import type { IConversionOrchestratorComponent, Platform } from './types'

type Components = Pick<
  AppComponents | TestComponents,
  'logs' | 'metrics' | 'config' | 'cdnS3' | 'sentry' | 'conversionTaskQueue' | 'publisher' | 'catalyst' | 'unityRunner'
>

/**
 * Builds the `IConversionOrchestratorComponent`. Reads the four config
 * values it cares about at construction time (platform, build target, AB
 * version, kill switch) so per-message dispatch doesn't pay the config
 * cost on the hot path.
 *
 * @param components - The orchestrator forwards `components` into
 *   `executeConversion` / `executeLODConversion` / `executeTriagePass`,
 *   so any field they need (`catalyst`, `unityRunner`, `cdnS3`, etc.)
 *   must be present even though the orchestrator's own dispatch logic
 *   only reads `conversionTaskQueue`, `publisher`, `metrics`, and `logs`.
 */
export async function createConversionOrchestratorComponent(
  components: Components
): Promise<IConversionOrchestratorComponent> {
  const { logs, metrics, config, conversionTaskQueue, publisher } = components
  const logger = logs.getLogger('conversion-orchestrator')

  const platform = (await config.requireString('PLATFORM')).toLocaleLowerCase() as Platform
  const buildTarget = await config.requireString('BUILD_TARGET')
  const abVersion = await config.requireString(getAbVersionEnvName(buildTarget))
  const triageEnabled = parseBooleanFlag(await config.getString('FAST_PATH_TRIAGE_ENABLED'), false, (raw) =>
    logger.warn(
      `Unrecognized value for FAST_PATH_TRIAGE_ENABLED: "${raw}" — falling back to the default (false). Accepted values: true/false/1/0/yes/no/on/off.`
    )
  )

  /**
   * Validates the shape of an incoming SQS job before either loop tries
   * to process it. Logs and returns false for anything that's not a real
   * conversion (e.g., `world_undeployment` events that leak into the SNS
   * topic, or malformed payloads with empty `contentServerUrls`).
   *
   * LOD jobs are special: they're identified by a `lods` array and don't
   * carry `contentServerUrls` — Unity reads the LOD GLBs directly from
   * the LOD list, not from a content server. They're not gated on
   * `contentServerUrls` presence.
   */
  function isValidConversionJob(job: DeploymentToSqs): boolean {
    if (!job?.entity?.entityId) {
      // Cast to loose record so the leaked `type` / `subType` discriminators
      // from non-conversion SNS events (e.g., `world_undeployment`) can be
      // surfaced in logs without forcing them onto DeploymentToSqs's typed
      // surface.
      const leaked = job as unknown as Record<string, string | undefined>
      logger.warn('Skipping job with no entity.entityId — not a conversion job', {
        type: leaked?.type ?? '',
        subType: leaked?.subType ?? ''
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

  /**
   * Builds and publishes the AssetBundleConversionFinishedEvent for a
   * completed (or failed) conversion. Called by every terminal branch
   * in the dispatch tree so downstream consumers (asset-bundle-registry,
   * dashboards) see one event per processed job.
   *
   * @param statusCode - Unity exit code, or 13 (already-converted) /
   *   5 (probe failed) for triage-fast-path completions.
   */
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

  /**
   * Forwards a job from the triage queue to the Conversion queue,
   * preserving the priority lane. Increments
   * `ab_converter_conversion_queue_publish_total` on success.
   *
   * On publish failure throws {@link ConversionQueueRepublishFailedError}
   * so the caller can fall back to running the conversion inline (see
   * `processIncomingJob`). Callers MUST handle the throw — letting it
   * propagate out of the triage loop's `consumeAndProcessJob` would let
   * the SQS adapter's delete-in-finally drop the triage message, losing
   * work permanently.
   *
   * **Required ops gate before flipping FAST_PATH_TRIAGE_ENABLED=true**:
   * configure an alert on
   * `ab_converter_conversion_queue_publish_errors_total > 0` with a low
   * threshold (any non-zero rate is suspicious). The inline-fallback
   * keeps work flowing but converts the failure mode from "lost work"
   * into "this pod ran a long Unity conversion instead of just a
   * triage probe", which is worth investigating.
   */
  async function republishToConversionQueue(job: DeploymentToSqs, isPriority: boolean): Promise<void> {
    try {
      await conversionTaskQueue.publish(job, isPriority)
      metrics.increment('ab_converter_conversion_queue_publish_total', {
        build_target: buildTarget,
        priority: isPriority ? 'priority' : 'standard'
      })
    } catch (err: any) {
      logger.error(`Failed to republish job to Conversion queue: ${err?.message ?? err}`, {
        entityId: job?.entity?.entityId
      })
      metrics.increment('ab_converter_conversion_queue_publish_errors_total', {
        build_target: buildTarget
      })
      throw new ConversionQueueRepublishFailedError(job.entity.entityId, buildTarget, err)
    }
  }

  /**
   * Republishes to the Conversion queue and, on publish failure, falls
   * back to running the full conversion inline so no work is lost.
   * Increments `ab_converter_republish_fallback_inline_total` when the
   * fallback fires — pair with the publish-errors counter to confirm
   * fallback coverage.
   */
  async function republishOrFallbackInline(
    job: DeploymentToSqs,
    isPriority: boolean,
    versionToUse: string
  ): Promise<void> {
    try {
      await republishToConversionQueue(job, isPriority)
    } catch (err) {
      if (!(err instanceof ConversionQueueRepublishFailedError)) throw err
      metrics.increment('ab_converter_republish_fallback_inline_total', { build_target: buildTarget })
      logger.warn(
        `Conversion-queue publish failed — running conversion inline on this pod to avoid losing work. entityId=${job.entity.entityId}`
      )
      await runFullConversionAndPublish(job, versionToUse)
    }
  }

  /**
   * Heavy path: spawn Unity (or LOD-Unity), upload the bundles, and
   * publish the finished event. Wraps the conversion call with the
   * `ab_converter_running_conversion` gauge so dashboards reflect
   * Unity-spawning work in flight. Called by both the triage loop's
   * default-mode branch (kill switch off) and the conversion loop.
   */
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

  /**
   * Triage loop's per-message handler. Validates the job, then dispatches
   * based on `FAST_PATH_TRIAGE_ENABLED` and the job shape:
   *
   * - LOD jobs always need Unity — when triage is on they're republished
   *   to the Conversion queue, otherwise they run inline.
   * - When triage is off, scenes run today's full `executeConversion`
   *   path inline.
   * - When triage is on, scenes run `executeTriagePass` and either
   *   fast-path (cache hit / already-converted), publish a failure event
   *   (probe error), or republish to the Conversion queue (cache miss).
   *
   * @param isPriority - True when the message arrived from the priority
   *   triage queue. Preserved end-to-end on Conversion-queue republish so
   *   the priority lane stays separated.
   */
  async function processIncomingJob(job: DeploymentToSqs, isPriority: boolean): Promise<void> {
    if (!isValidConversionJob(job)) return

    // Increment version if doISS is true (legacy v2004 path)
    const versionToUse = job.doISS ? 'v2004' : abVersion

    // LOD jobs always need Unity — they never fast-path.
    if (job.lods) {
      if (triageEnabled) {
        await republishOrFallbackInline(job, isPriority, versionToUse)
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
          // ab_converter_conversion_queue_publish_errors_total alarm pattern.
          await publishFinishedEvent(job, outcome.exitCode, versionToUse)
          return
        case 'failed':
          // Sentinel was uploaded by executeTriagePass; emit the finished event so
          // the publisher's downstream consumers see the failure status, then ack.
          await publishFinishedEvent(job, outcome.exitCode, versionToUse)
          return
        case 'needs-unity':
          await republishOrFallbackInline(job, isPriority, versionToUse)
          return
      }
    } finally {
      metrics.decrement('ab_converter_running_triage')
    }
  }

  /**
   * Conversion loop's per-message handler. Always runs the full
   * conversion (no kill-switch branching) so any job that lands on the
   * Conversion queue gets processed regardless of
   * `FAST_PATH_TRIAGE_ENABLED`. Re-runs the probe inside
   * `executeConversion`, so peer-pod canonicalisations since the original
   * triage pass produce a free fast-path short-circuit.
   *
   * The validation guard is defensive: messages reach this queue only via
   * `processIncomingJob`, which already validates. The guard catches
   * manually-injected SQS messages (operator using the AWS console for
   * incident response) and won't false-positive on the normal flow.
   */
  async function processConversionJob(job: DeploymentToSqs): Promise<void> {
    if (!isValidConversionJob(job)) return
    const versionToUse = job.doISS ? 'v2004' : abVersion
    await runFullConversionAndPublish(job, versionToUse)
  }

  return { processIncomingJob, processConversionJob }
}
