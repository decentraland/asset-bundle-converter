import type { Entity } from '@dcl/schemas'
import type { IBaseComponent } from '@well-known-components/interfaces'

/**
 * HTTP client for Decentraland catalysts (and the worlds-content-server,
 * which exposes a compatible subset). All conversion I/O against the
 * catalyst funnels through this component so tests can inject a fake and
 * Sentry/log instrumentation can live in one place.
 */
export type ICatalystComponent = IBaseComponent & {
  /**
   * Fetch a single entity snapshot by its content hash (CID).
   *
   * Uses GET `/contents/{id}` rather than POST `/entities/active` because
   * worlds-content-server only supports the former.
   *
   * @param timeoutMs - Optional per-call abort. Callers like the migration
   *   script pass a bound (e.g. 30s) so a hung catalyst can't stall the
   *   whole run; the HTTP serving path that calls this without a timeout
   *   keeps the pre-existing behaviour of waiting indefinitely (and relies
   *   on the SQS visibility timeout to retry).
   * @throws when `id` is not in the expected `[a-zA-Z0-9]+` shape (CID).
   * @throws when the catalyst returns a non-2xx status.
   */
  getActiveEntity(id: string, contentServer: string, timeoutMs?: number): Promise<Entity>

  /**
   * Fetch active entities by pointer list. Used by the legacy
   * has-content-changed path.
   */
  getEntities(pointers: string[], sourceServer: string): Promise<Entity[]>
}
