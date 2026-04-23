import { IFetchComponent } from '@well-known-components/interfaces'

export async function createFetchComponent() {
  const fetch: IFetchComponent = {
    async fetch(url: any, init?: any): Promise<any> {
      return globalThis.fetch(url, init)
    }
  }

  return fetch
}
