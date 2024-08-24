import { HandlerContextWithPath } from '../../types'
import { IHttpServerComponent } from '@well-known-components/interfaces'

export type StatusResponse = {
  commitHash: string
  version: string
}

export async function statusHandler(
  context: HandlerContextWithPath<'config', '/status'>
): Promise<IHttpServerComponent.IResponse> {
  const { config } = context.components

  const [commitHash, version] = await Promise.all([
    config.getString('COMMIT_HASH'),
    config.getString('CURRENT_VERSION')
  ])

  const status: StatusResponse = {
    commitHash: commitHash || 'unknown',
    version: version || 'unknown'
  }

  return {
    status: 200,
    body: status
  }
}
