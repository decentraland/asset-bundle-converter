// Module-level shutdown / fatal-exit state for the conversion worker.
//
// After a timeout or crash in Unity, reusing the same worker for the next SQS
// job has caused cascading failures (RCA 2026-04-19): leftover file locks,
// orphan processes, or corrupted Library state make the second conversion
// hang and eventually crash the container with exit code 199.
//
// The design:
//   - requestShutdown() is called from the catch block of a failed conversion.
//     It flips a flag that the main loop checks between SQS receives so no new
//     job is picked up.
//   - scheduleFatalExit() schedules process.exit(199) as a hard backstop in
//     case the main loop never gets control again (e.g. the SQS adapter's
//     deleteMessage finally-block throws and traps execution in its inner
//     retry loop). It also sets process.exitCode so that if Node tears down
//     cleanly before the timer fires, the exit code still reflects the
//     failure to ECS.

const FATAL_EXIT_TIMEOUT_MS = 60_000
const FATAL_EXIT_CODE = 199

let shutdownRequested = false
let fatalExitScheduled = false
let fatalExitTimer: NodeJS.Timeout | null = null

export function isShutdownRequested(): boolean {
  return shutdownRequested
}

export function requestShutdown(): void {
  shutdownRequested = true
}

export function scheduleFatalExit(): void {
  if (fatalExitScheduled) return
  fatalExitScheduled = true
  process.exitCode = FATAL_EXIT_CODE
  // Intentionally not .unref()'d: keep the event loop alive so process.exit
  // is guaranteed to fire even if the HTTP server and runner tear down
  // cleanly in the meantime.
  fatalExitTimer = setTimeout(() => {
    process.exit(FATAL_EXIT_CODE)
  }, FATAL_EXIT_TIMEOUT_MS)
}

// Test-only helper: reset the module-level flags and clear any pending
// fatal-exit timer. Not intended for production use — exporting only so the
// test suite can run multiple scenarios against this module.
export function _resetShutdownStateForTests(): void {
  shutdownRequested = false
  fatalExitScheduled = false
  if (fatalExitTimer) {
    clearTimeout(fatalExitTimer)
    fatalExitTimer = null
  }
  process.exitCode = 0
}
