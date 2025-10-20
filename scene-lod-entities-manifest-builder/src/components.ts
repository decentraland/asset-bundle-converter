import { createDotEnvConfigComponent } from '@well-known-components/env-config-provider'
import { createFetchComponent } from '@well-known-components/fetch-component'
import { BaseComponents } from './types'
import { createSceneFetcherComponent } from './logic/sceneFetcher'

// Initialize all the components of the app
export async function initComponents(): Promise<BaseComponents> {
  const config = await createDotEnvConfigComponent({ path: ['.env.default', '.env'] }, {
    HTTP_SERVER_PORT: '3001',
    HTTP_SERVER_HOST: '0.0.0.0'
  })
  const fetch = createFetchComponent()
  const sceneFetcher = await createSceneFetcherComponent({ config, fetch })

  return {
    config,
    fetch,
    sceneFetcher
  }
}
