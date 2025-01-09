import { Events } from '@dcl/schemas'
import { HandlerContextWithPath } from '../../types'
import { DeploymentToSqs } from '@dcl/schemas/dist/misc/deployments-to-sqs'
import { IHttpServerComponent } from '@well-known-components/interfaces'

export async function queueTaskHandler(
  context: HandlerContextWithPath<'taskQueue' | 'config' | 'publisher', '/queue-task'>
): Promise<IHttpServerComponent.IResponse> {
  const {
    components: { taskQueue, config, publisher },
    request
  } = context

  const platform = await config.requireString('PLATFORM')

  if (request.headers.get('Authorization') !== (await config.requireString('TMP_SECRET')))
    return { status: 401, body: 'Unauthorized' }

  const body = await request.json()

  if (!DeploymentToSqs.validate(body)) return { status: 403, body: { errors: DeploymentToSqs.validate.errors } }

  const shouldPrioritize = !!(body as any)?.prioritize
  const message = await taskQueue.publish(body as DeploymentToSqs, shouldPrioritize)

  await publisher.publishMessage({
    type: Events.Type.ASSET_BUNDLE,
    subType: Events.SubType.AssetBundle.MANUALLY_QUEUED,
    key: `${body.entity.entityId}-${platform}`,
    timestamp: Date.now(),
    metadata: {
      platform: platform.toLocaleLowerCase() as 'windows' | 'mac' | 'webgl',
      entityId: body.entity.entityId,
      isLods: !!body.lods,
      isPriority: shouldPrioritize
    }
  })

  return {
    status: 201,
    body: message
  }
}
