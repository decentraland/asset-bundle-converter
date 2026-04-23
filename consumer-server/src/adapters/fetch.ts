import { IFetchComponent } from '@well-known-components/interfaces'

/**
 * Build the fetch component on top of the runtime's native `fetch`.
 */
export async function createFetchComponent() {
  const fetch: IFetchComponent = {
    async fetch(url: any, init?: any): Promise<any> {
      return globalThis.fetch(url, init)
    }
  }

  return fetch
}
