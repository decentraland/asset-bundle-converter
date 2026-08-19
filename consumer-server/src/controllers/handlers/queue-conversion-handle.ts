import { createHash, timingSafeEqual } from 'crypto'
import { Events } from '@dcl/schemas'
import { HandlerContextWithPath } from '../../types'
import { DeploymentToSqs } from '@dcl/schemas/dist/misc/deployments-to-sqs'
import { IHttpServerComponent } from '@dcl/core-commons'
import { getAbVersionEnvName } from '../../utils'

/**
 * Constant-time comparison of the request's bearer secret against the
 * configured `TMP_SECRET`. Both sides are SHA-256 hashed first so the compared
 * buffers are always 32 bytes: that keeps `timingSafeEqual` from throwing on a
 * length mismatch AND stops the comparison from leaking the secret's length.
 * A plain `!==` short-circuits on the first differing byte — a (weak, but
 * free-to-close) timing oracle on the shared secret.
 */
function secretMatches(provided: string | null, expected: string): boolean {
  const providedHash = createHash('sha256')
    .update(provided ?? '')
    .digest()
  const expectedHash = createHash('sha256').update(expected).digest()
  return timingSafeEqual(providedHash, expectedHash)
}

export async function queueTaskHandler(
  context: HandlerContextWithPath<'triageTaskQueue' | 'config' | 'publisher', '/queue-task'>
): Promise<IHttpServerComponent.IResponse> {
  const {
    components: { triageTaskQueue, config, publisher },
    request
  } = context

  if (!secretMatches(request.headers.get('Authorization'), await config.requireString('TMP_SECRET'))) {
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

  if (!DeploymentToSqs.validate(body)) return { status: 403, body: { errors: DeploymentToSqs.validate.errors } }

  const shouldPrioritize = !!(body as any)?.prioritize
  const message = await triageTaskQueue.publish(body as DeploymentToSqs, shouldPrioritize)

  await publisher.publishMessage({
    type: Events.Type.ASSET_BUNDLE,
    subType: Events.SubType.AssetBundle.MANUALLY_QUEUED,
    key: `${body.entity.entityId}-${platform}`,
    timestamp: Date.now(),
    metadata: {
      platform: platform.toLocaleLowerCase() as 'windows' | 'mac',
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
