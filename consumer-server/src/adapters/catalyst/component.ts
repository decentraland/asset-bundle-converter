import type { Entity } from '@dcl/schemas'
import type { IFetchComponent } from '@dcl/core-commons'
import type { AppComponents } from '../../types'
import type { ICatalystComponent } from './types'

/**
 * Standalone implementation of `getActiveEntity` — exported for CLI scripts
 * (migrate-to-canonical, test-conversion) that don't construct the full
 * components container. The component method below delegates to this so the
 * two surfaces stay byte-identical.
 */
export async function fetchActiveEntity(id: string, contentServer: string, timeoutMs?: number): Promise<Entity> {
  // Optional per-call timeout via AbortController. Callers that pass a
  // bound prevent a hung catalyst from stalling the whole run.
  const controller = timeoutMs !== undefined ? new AbortController() : undefined
  const timeoutHandle = controller !== undefined ? setTimeout(() => controller.abort(), timeoutMs) : undefined

  try {
    // GET /contents/{CID} returns the entity snapshot directly. Works on both
    // regular catalysts and the worlds-content-server (which doesn't support
    // POST /entities/active with { ids: [...] }).
    if (!/^[a-zA-Z0-9]+$/.test(id)) {
      throw new Error(`Invalid entity ID format: ${id}`)
    }
    const base = contentServer.endsWith('/') ? contentServer : contentServer + '/'
    const url = `${base}contents/${id}`
    // Native fetch is used here (not the IFetchComponent) because we need
    // AbortSignal support which the wrapper doesn't expose.
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

/**
 * POST `/entities/active` with the requested pointer list. Used by the
 * legacy `has-content-changed` flow to discover entities by pointer.
 *
 * @throws when the catalyst returns a non-2xx response — error message
 *   carries the response body for incident triage.
 */
async function fetchEntitiesByPointers(
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

/**
 * Builds the `ICatalystComponent`. Both methods delegate to the
 * standalone helpers (`fetchActiveEntity` / `fetchEntitiesByPointers`)
 * so the same logic can be invoked from CLI scripts that don't carry a
 * components container.
 *
 * @param components - Needs only `fetch` (the IFetchComponent wrapper).
 *   The `getActiveEntity` path uses native `globalThis.fetch` directly
 *   because the wrapper doesn't expose AbortSignal.
 */
export async function createCatalystComponent(components: Pick<AppComponents, 'fetch'>): Promise<ICatalystComponent> {
  const { fetch: fetchComponent } = components

  async function getActiveEntity(id: string, contentServer: string, timeoutMs?: number): Promise<Entity> {
    return fetchActiveEntity(id, contentServer, timeoutMs)
  }

  async function getEntities(pointers: string[], sourceServer: string): Promise<Entity[]> {
    return fetchEntitiesByPointers(fetchComponent, pointers, sourceServer)
  }

  return { getActiveEntity, getEntities }
}
