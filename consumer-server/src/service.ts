import { Lifecycle } from '@well-known-components/interfaces'
import { setupRouter } from './controllers/routes'
import { executeConversion, executeLODConversion } from './logic/conversion-task'
import checkDiskSpace from 'check-disk-space'
import { AppComponents, GlobalContext, TestComponents } from './types'
import { AssetBundleConversionFinishedEvent, Events } from '@dcl/schemas'

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

  const logger = components.logs.getLogger('main-loop')

  components.runner.runTask(async (opt) => {
    const platform = (await components.config.requireString('PLATFORM')).toLocaleLowerCase() as
      | 'windows'
      | 'mac'
      | 'webglb'
    while (opt.isRunning) {
      if (await machineRanOutOfSpace(components)) {
        logger.warn('Stopping program due to lack of disk space')
        void program.stop()
        return
      }

      await components.taskQueue.consumeAndProcessJob(async (job, _message) => {
        let statusCode: number
        try {
          components.metrics.increment('ab_converter_running_conversion')
          if (job.lods) {
            statusCode = await executeLODConversion(components, job.entity.entityId, job.lods)
          } else {
            statusCode = await executeConversion(
              components,
              job.entity.entityId,
              job.contentServerUrls![0],
              job.force,
              job.animation
            )
          }

          const eventToPublish: AssetBundleConversionFinishedEvent = {
            type: Events.Type.ASSET_BUNDLE,
            subType: Events.SubType.AssetBundle.CONVERTED,
            key: `${job.entity.entityId}-${platform}`,
            timestamp: Date.now(),
            metadata: {
              platform: platform,
              entityId: job.entity.entityId,
              isLods: !!job.lods,
              statusCode
            }
          }

          await components.publisher.publishMessage(eventToPublish, {
            type: Events.Type.ASSET_BUNDLE,
            subType: Events.SubType.AssetBundle.CONVERTED
          })
        } finally {
          components.metrics.decrement('ab_converter_running_conversion')
        }
      })
    }
  })
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
