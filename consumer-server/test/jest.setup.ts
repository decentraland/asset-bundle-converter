// `src/logic/conversion-task.ts`'s fatal-error handler schedules a real
// `setTimeout(() => process.exit(199), 60_000)` so Prometheus can scrape metrics
// before the process dies in production. Tests that exercise the fatal path spy
// on `process.exit`, but the 60s timer is left pending; depending on machine
// speed it fires either mid-run or after the spy is restored, calling the real
// `process.exit(199)` and killing the whole jest run (flaky `exit 199`).
//
// Swallow ONLY that 60s timer — replace it with a harmless, immediately-cleared
// no-op so its `process.exit(199)` callback never runs. Every other timer passes
// through untouched, and jest's own `--forceExit` (which calls `process.exit`)
// is unaffected. The fatal handler is the only 60_000 ms `setTimeout` in the
// codebase, so matching on the delay is safe.
const realSetTimeout = globalThis.setTimeout
globalThis.setTimeout = function (this: unknown, handler: TimerHandler, timeout?: number, ...args: unknown[]) {
  if (timeout === 60_000) {
    const noop = realSetTimeout.call(globalThis, () => {}, 0)
    ;(noop as { unref?: () => void }).unref?.()
    return noop
  }
  return realSetTimeout.apply(this, [handler, timeout, ...args] as never)
} as typeof setTimeout
