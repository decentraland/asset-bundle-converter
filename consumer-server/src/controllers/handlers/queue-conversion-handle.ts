import { HandlerContextWithPath } from "../../types"
import { DeploymentToSqs } from '@dcl/schemas/dist/misc/deployments-to-sqs'
import { IHttpServerComponent } from "@well-known-components/interfaces"

// handlers arguments only type what they need, to make unit testing easier
export async function queueTaskHandler(context: HandlerContextWithPath<"metrics" | "taskQueue" | 'config', "/queue-task">): Promise<IHttpServerComponent.IResponse> {
  const {
    url,
    components: { taskQueue, config },
    request
  } = context

  if (request.headers.get('Authorization') !== await config.requireString('TMP_SECRET')) return { status: 401, body: 'Unauthorized' }

  const body = await request.json()

  if (!DeploymentToSqs.validate(body)) return { status: 403, body: { errors: DeploymentToSqs.validate.errors } }

  const message = await taskQueue.publish(body as DeploymentToSqs & { lodBucketDirectory: string | undefined; })

  return {
    status: 201,
    body: message,
  }
}
