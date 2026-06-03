import { Events } from '@dcl/schemas'
import { HandlerContextWithPath } from '../../types'
import { DeploymentToSqs } from '@dcl/schemas/dist/misc/deployments-to-sqs'
import { IHttpServerComponent } from '@well-known-components/interfaces'
import { getAbVersionEnvName } from '../../utils'
import { timingSafeEqual } from 'crypto'

export async function queueTaskHandler(
  context: HandlerContextWithPath<'triageTaskQueue' | 'config' | 'publisher' | 'logs', '/queue-task'>
): Promise<IHttpServerComponent.IResponse> {
  const {
    components: { triageTaskQueue, config, publisher, logs },
    request
  } = context
  const logger = logs.getLogger('queue-task-handler')

  // Constant-time auth check so the shared secret isn't probeable via response
  // timing. (TMP_SECRET is a placeholder-named shared key — treat it as a
  // managed, rotatable secret, not a long-lived constant.)
  const provided = Buffer.from(request.headers.get('Authorization') ?? '')
  const expected = Buffer.from(await config.requireString('TMP_SECRET'))
  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
    return {
      status: 401,
      body: 'Unauthorized'
    }
  }

  const platform = await config.requireString('PLATFORM')

  const $BUILD_TARGET = await config.requireString('BUILD_TARGET')
  const abVersionEnvName = getAbVersionEnvName($BUILD_TARGET)
  const $AB_VERSION = await config.requireString(abVersionEnvName)

  const body = await request.json()

  if (!DeploymentToSqs.validate(body)) {
    // Don't reflect schema-validator internals (field paths) to the caller; log
    // them server-side for debugging instead.
    logger.warn('queue-task payload failed schema validation', {
      errors: JSON.stringify(DeploymentToSqs.validate.errors ?? [])
    })
    return { status: 403, body: { error: 'Invalid request body' } }
  }

  const shouldPrioritize = !!(body as any)?.prioritize
  const message = await triageTaskQueue.publish(body as DeploymentToSqs, shouldPrioritize)

  await publisher.publishMessage({
    type: Events.Type.ASSET_BUNDLE,
    subType: Events.SubType.AssetBundle.MANUALLY_QUEUED,
    key: `${body.entity.entityId}-${platform}`,
    timestamp: Date.now(),
    metadata: {
      platform: platform.toLocaleLowerCase() as 'windows' | 'mac' | 'webgl',
      entityId: body.entity.entityId,
      isLods: !!body.lods,
      isPriority: shouldPrioritize,
      version: $AB_VERSION
    }
  })

  return {
    status: 201,
    body: message
  }
}
