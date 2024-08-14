import * as nodeFetch from 'node-fetch'
import { IFetchComponent } from '@well-known-components/interfaces'

export async function createFetchComponent() {
  const fetch: IFetchComponent = {
    async fetch(url: nodeFetch.RequestInfo, init?: nodeFetch.RequestInit): Promise<nodeFetch.Response> {
      return nodeFetch.default(url, init)
    }
  }

  return fetch
}
