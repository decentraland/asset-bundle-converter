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

  const triageLogger = components.logs.getLogger('triage-loop')
  const unityLogger = components.logs.getLogger('unity-loop')

  // Triage loop. When `FAST_PATH_TRIAGE_ENABLED` is off (default), the
  // orchestrator's processIncomingJob runs full executeConversion inline
  // (today's behavior). When on, it runs executeTriagePass and either
  // fast-paths or republishes to the Unity queue. See
  // `logic/conversion-orchestrator/component.ts` for the full decision tree.
  components.runner.runTask(async (opt) => {
    while (opt.isRunning) {
      if (await components.filesystem.isBelowMinimum()) {
        triageLogger.warn('Stopping program due to lack of disk space')
        void program.stop()
        return
      }

      await components.triageTaskQueue.consumeAndProcessJob(async (job, _message, opts) => {
        await components.conversionOrchestrator.processIncomingJob(job, opts.isPriority)
      })
    }
  })

  // Unity loop. Always runs; drains the Unity queue regardless of the kill
  // switch. When the switch is off, no new messages land here, so this loop
  // sits idle. On revert, any residual messages drain naturally.
  components.runner.runTask(async (opt) => {
    while (opt.isRunning) {
      if (await components.filesystem.isBelowMinimum()) {
        unityLogger.warn('Stopping program due to lack of disk space (unity loop)')
        void program.stop()
        return
      }

      await components.unityTaskQueue.consumeAndProcessJob(async (job, _message, _opts) => {
        await components.conversionOrchestrator.processUnityJob(job)
      })
    }
  })
}
