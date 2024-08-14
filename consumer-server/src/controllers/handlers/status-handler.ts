import { HandlerContextWithPath } from '../../types'
import { IHttpServerComponent } from '@well-known-components/interfaces'

export type StatusResponse = {
  commitHash: string
}

export async function statusHandler(
  context: HandlerContextWithPath<'config', '/status'>
): Promise<IHttpServerComponent.IResponse> {
  const { config } = context.components

  const commitHash = (await config.getString('COMMIT_HASH')) || 'unknown'

  const status: StatusResponse = {
    commitHash
  }

  return {
    status: 200,
    body: status
  }
}
