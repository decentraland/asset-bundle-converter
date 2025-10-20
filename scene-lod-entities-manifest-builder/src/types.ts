import type { IFetchComponent } from '@well-known-components/http-server'
import type { IConfigComponent } from '@well-known-components/interfaces'

// components used in every environment
export type BaseComponents = {
  config: IConfigComponent
  fetch: IFetchComponent
  sceneFetcher: SceneFetcherComponent
}

export type SceneFetcherComponent = {
  getGameDataFromRemoteSceneByCoords(sceneCoords: string): Promise<string>
  getGameDataFromRemoteSceneByID(paramSceneId: string): Promise<string>
  getGameDataFromLocalScene(scenePath: string): Promise<string>
}
