import { IFetchComponent } from '@dcl/core-commons'

/**
 * Build the fetch component on top of the runtime's native `fetch`.
 *
 * `@dcl/core-commons`' `IFetchComponent` is typed against the native (undici)
 * `Request` / `Response` / `RequestInit`, so `globalThis.fetch` satisfies it
 * directly — no cast needed.
 */
export async function createFetchComponent(): Promise<IFetchComponent> {
  return {
    fetch: (url, init) => globalThis.fetch(url, init)
  }
}
