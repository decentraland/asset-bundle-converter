/**
 * Thrown when the orchestrator's triage path determined the job needs Unity
 * but `unityTaskQueue.publish()` failed. Caller (the SQS adapter's
 * consumeAndProcessJob runner) sees a thrown error and acks the triage
 * message in its `finally` — work is permanently lost.
 *
 * The orchestrator throws this typed error so callers can distinguish
 * lost-work failures from unrelated failures (e.g., metric emission errors)
 * if more nuanced handling is added to the queue contract later. Today the
 * SQS adapter doesn't differentiate; the value is purely diagnostic for
 * Sentry / log filtering.
 */
export class UnityQueueRepublishFailedError extends Error {
  constructor(
    public readonly entityId: string,
    public readonly buildTarget: string,
    public readonly cause: unknown
  ) {
    const message = cause instanceof Error ? cause.message : String(cause)
    super(`Failed to republish job to Unity queue (entityId=${entityId}, buildTarget=${buildTarget}): ${message}`)
    this.name = 'UnityQueueRepublishFailedError'
  }
}
