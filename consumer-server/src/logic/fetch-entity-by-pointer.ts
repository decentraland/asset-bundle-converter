import { Entity } from '@dcl/schemas'
import { IFetchComponent } from '@well-known-components/interfaces'

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
  // Optional per-call timeout via AbortController. Callers like the migration
  // script pass a bound (e.g. 30s) so a hung catalyst can't stall the whole
  // run; the HTTP serving path that calls this without a timeout keeps the
  // pre-existing behaviour of waiting indefinitely (and relying on the SQS
  // visibility timeout to retry if it does).
  const controller = timeoutMs !== undefined ? new AbortController() : undefined
  const timeoutHandle = controller !== undefined ? setTimeout(() => controller.abort(), timeoutMs) : undefined

  try {
    // GET /contents/{CID} returns the entity snapshot directly. Works on both
    // regular catalysts and the worlds content server (which doesn't support
    // POST /entities/active with { ids: [...] }).
    const base = contentServer.endsWith('/') ? contentServer : contentServer + '/'
    const url = `${base}contents/${id}`
    const res = await fetch(url, { signal: controller?.signal })

    if (!res.ok) {
      const body = await res.text()
      throw new Error(`Failed to fetch entity ${id} from ${url}: ${body}`)
    }

    const entity = JSON.parse(await res.text())
    // The /contents/ response may be missing the `id` field. Ensure it's set.
    if (!entity.id) {
      entity.id = id
    }
    return entity
  } finally {
    if (timeoutHandle !== undefined) clearTimeout(timeoutHandle)
  }
}
