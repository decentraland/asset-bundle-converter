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

export async function getActiveEntity(
  id: string,
  contentServer: string,
  timeoutMs?: number
): Promise<Entity | undefined> {
  const url = `${contentServer}/entities/active`

  // Optional per-call timeout via AbortController. Callers like the migration
  // script pass a bound (e.g. 30s) so a hung catalyst can't stall the whole
  // run; the HTTP serving path that calls this without a timeout keeps the
  // pre-existing behaviour of waiting indefinitely (and relying on the SQS
  // visibility timeout to retry if it does).
  //
  // A non-positive `timeoutMs` is treated as "no timeout" rather than instant-
  // abort. `setTimeout(abort, 0)` would fire on the next tick — before the
  // fetch even resolves DNS — which is almost never what a caller meant. The
  // migration script clamps to a 1s floor before reaching this helper, but we
  // also guard here so future callers can't foot-shoot.
  const useTimeout = timeoutMs !== undefined && timeoutMs > 0
  const controller = useTimeout ? new AbortController() : undefined
  const timeoutHandle = controller !== undefined ? setTimeout(() => controller.abort(), timeoutMs) : undefined

  try {
    const res = await globalThis.fetch(url, {
      method: 'post',
      body: JSON.stringify({ ids: [id] }),
      headers: { 'content-type': 'application/json' },
      signal: controller?.signal
    })

    const response = await res.text()

    if (!res.ok) {
      throw new Error('Error fetching list of active entities: ' + response)
    }

    // The catalyst returns `[]` when the entity is no longer active (redeployed
    // / evicted). Surface that as `undefined` rather than letting `[0]` quietly
    // produce one — the caller decides whether to fall back or throw.
    return JSON.parse(response)[0]
  } finally {
    if (timeoutHandle !== undefined) clearTimeout(timeoutHandle)
  }
}
