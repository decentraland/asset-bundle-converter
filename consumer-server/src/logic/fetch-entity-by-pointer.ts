import { Entity } from '@dcl/schemas'
import { IFetchComponent } from '@well-known-components/interfaces'
import fetch from 'node-fetch'

export async function getEntities(
  fetcher: IFetchComponent,
  pointers: string[],
  sourceServer: string
): Promise<Entity[]> {
  const url = `${sourceServer}/entities/active`
  const res = await fetcher.fetch(url, {
    method: 'post',
    body: JSON.stringify({ pointers }),
    headers: { 'content-type': 'application/json' }
  })

  const response = await res.text()

  if (!res.ok) {
    throw new Error('Error fetching list of active entities: ' + response)
  }

  return JSON.parse(response)
}

export async function getActiveEntity(id: string, contentServer: string, timeoutMs?: number): Promise<Entity> {
  const url = `${contentServer}/entities/active`

  // Optional per-call timeout via AbortController. Callers like the migration
  // script pass a bound (e.g. 30s) so a hung catalyst can't stall the whole
  // run; the HTTP serving path that calls this without a timeout keeps the
  // pre-existing behaviour of waiting indefinitely (and relying on the SQS
  // visibility timeout to retry if it does).
  const controller = timeoutMs !== undefined ? new AbortController() : undefined
  const timeoutHandle = controller !== undefined ? setTimeout(() => controller.abort(), timeoutMs) : undefined

  try {
    const res = await fetch(url, {
      method: 'post',
      body: JSON.stringify({ ids: [id] }),
      headers: { 'content-type': 'application/json' },
      signal: controller?.signal
    })

    const response = await res.text()

    if (!res.ok) {
      throw new Error('Error fetching list of active entities: ' + response)
    }

    return JSON.parse(response)[0]
  } finally {
    if (timeoutHandle !== undefined) clearTimeout(timeoutHandle)
  }
}
