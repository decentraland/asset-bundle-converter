import type { IBaseComponent } from '@well-known-components/interfaces'
import type { DeploymentToSqs } from '@dcl/schemas/dist/misc/deployments-to-sqs'

export type Platform = 'windows' | 'mac' | 'webgl'

/**
 * Owns the per-message decision tree for both consumer loops.
 *
 * Triage path (`processIncomingJob`):
 *  - Validates the job (entityId + non-LOD jobs need contentServerUrls).
 *  - LOD jobs short-circuit straight to the Unity queue (or to inline Unity
 *    when `FAST_PATH_TRIAGE_ENABLED=false`).
 *  - When the kill switch is off, runs full executeConversion inline
 *    (today's behavior).
 *  - When on, runs `executeTriagePass` (probe-only) and either fast-paths
 *    inline, publishes a failed-conversion event, or republishes to the
 *    Unity queue for cache-miss / force / ISS / non-scene / probe-error
 *    cases.
 *
 * Unity path (`processUnityJob`): always runs full executeConversion.
 * Re-runs the probe inside executeConversion so peer-pod canonicalisations
 * since the triage pass produce a free fast-path short-circuit.
 *
 * Both methods are independently safe to call concurrently from the two
 * runner loops; no shared mutable state inside the orchestrator.
 */
export type IConversionOrchestratorComponent = IBaseComponent & {
  processIncomingJob(job: DeploymentToSqs, isPriority: boolean): Promise<void>
  processUnityJob(job: DeploymentToSqs): Promise<void>
}
