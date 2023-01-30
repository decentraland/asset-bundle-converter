import { HandlerContextWithPath } from "../../types"
import { DeploymentToSqs } from '@dcl/schemas/dist/misc/deployments-to-sqs'

// handlers arguments only type what they need, to make unit testing easier
export async function queueTaskHandler(context: HandlerContextWithPath<"metrics" | "taskQueue" | 'config', "/queue-task">) {
  const {
    url,
    components: { taskQueue, config },
    request
  } = context

  if (request.headers.get('Authorization') !== await config.requireString('TMP_SECRET')) return { status: 401, body: 'Unauthorized' }

  const body = await request.json()

  if (!DeploymentToSqs.validate(body)) return { status: 403, body: DeploymentToSqs.validate.errors }

  const message = await taskQueue.publish(body)

  return {
    status: 201,
    body: message,
  }
}
