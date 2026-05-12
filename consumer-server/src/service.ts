import { Lifecycle } from '@well-known-components/interfaces'
import { setupRouter } from './controllers/routes'
import { AppComponents, GlobalContext, TestComponents } from './types'

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

  const conversionLogger = components.logs.getLogger('conversion-loop')

  // Triage loop. When `FAST_PATH_TRIAGE_ENABLED` is off (default), the
  // orchestrator's processIncomingJob runs full executeConversion inline
  // (today's behavior). When on, it runs executeTriagePass and either
  // fast-paths or republishes to the Conversion queue. See
  // `logic/conversion-orchestrator/component.ts` for the full decision tree.
  //
  // No disk-pressure gate here: in fast-path mode the triage loop only does
  // probe-and-republish work (no Unity spawn, no scene materialisation), so
  // it stays useful when disk is tight. The conversion loop owns the
  // disk-pressure shutdown — that's where the actual writes happen, and the
  // inline-fallback path runs `executeConversion` via the orchestrator, so
  // disk-pressure-triggered shutdown still fires on this pod when needed.
  components.runner.runTask(async (opt) => {
    while (opt.isRunning) {
      await components.triageTaskQueue.consumeAndProcessJob(async (job, _message, opts) => {
        await components.conversionOrchestrator.processIncomingJob(job, opts.isPriority)
      })
    }
  })

  // Conversion loop. Always runs; drains the Conversion queue regardless of
  // the kill switch. When the switch is off, no new messages land here, so
  // this loop sits idle. On revert, any residual messages drain naturally.
  components.runner.runTask(async (opt) => {
    while (opt.isRunning) {
      if (await components.filesystem.isBelowMinimum()) {
        conversionLogger.warn('Stopping program due to lack of disk space (conversion loop)')
        void program.stop()
        return
      }

      await components.conversionTaskQueue.consumeAndProcessJob(async (job, _message, _opts) => {
        await components.conversionOrchestrator.processConversionJob(job)
      })
    }
  })
}
