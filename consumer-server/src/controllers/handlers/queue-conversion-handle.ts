import { CatalystDeploymentEvent } from '@dcl/schemas'
import { HandlerContextWithPath } from '../../types'
import { DeploymentToSqs } from '@dcl/schemas/dist/misc/deployments-to-sqs'
import { IHttpServerComponent } from '@well-known-components/interfaces'

export async function queueTaskHandler(
  context: HandlerContextWithPath<'taskQueue' | 'config', '/queue-task'>
): Promise<IHttpServerComponent.IResponse> {
  const {
    components: { taskQueue, config },
    request
  } = context

  if (request.headers.get('Authorization') !== (await config.requireString('TMP_SECRET')))
    return { status: 401, body: 'Unauthorized' }

  const body = await request.json()

  if (!CatalystDeploymentEvent.validate(body)) return { status: 403, body: { errors: DeploymentToSqs.validate.errors } }

  const shouldPrioritize = !!(body as any)?.prioritize
  const message = await taskQueue.publish(body as CatalystDeploymentEvent, shouldPrioritize)

  return {
    status: 201,
    body: message
  }
}
