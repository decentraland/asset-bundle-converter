import { existsSync, readFileSync } from 'fs'
import { manifestFileDir, manifestFileNameEnd } from './scene-runtime/apis'
import { BaseComponents, SceneFetcherComponent } from '../types'

export let contentFetchBaseUrl: string | undefined = undefined
const mainCRDTFileName = 'main.crdt'
export let sdk6SceneContent: any
export let sdk6FetchComponent: any
export let mainCrdt: any
export let sceneId: string = 'local-scene' // will get overwritten if a remote scene is targeted

export async function createSceneFetcherComponent({
  config,
  fetch
}: Pick<BaseComponents, 'config' | 'fetch'>): Promise<SceneFetcherComponent> {
  contentFetchBaseUrl = (await config.requireString('CATALYST_URL')) + '/content/contents/'
  const mappingsUrl = (await config.requireString('CATALYST_URL')) + '/content/entities/active'

  async function getGameDataFromRemoteSceneByCoords(sceneCoords: string): Promise<string> {
    // get scene id
    const fetchResponse = await fetch.fetch(mappingsUrl, {
      method: 'post',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pointers: [sceneCoords] })
    })
    const sceneData = (await fetchResponse.json())[0]
    sceneId = sceneData.id
    return await processRemoteResponse(sceneData)
  }

  async function getGameDataFromRemoteSceneByID(paramSceneId: string): Promise<string> {
    sceneId = paramSceneId
    const fetchResponse = await fetch.fetch(`${contentFetchBaseUrl}${sceneId}`, {
      method: 'get',
      headers: { 'content-type': 'application/json' }
    })
    const sceneData = await fetchResponse.json()
    return await processRemoteResponse(sceneData)
  }

  async function processRemoteResponse(sceneData: any): Promise<string> {
    if (!process.env.npm_config_overwrite && existsSync(`${manifestFileDir}/${sceneId}${manifestFileNameEnd}`)) {
      throw new Error(`ABORT: ${sceneId}${manifestFileNameEnd} manifest file already exists.`)
    }

    console.log(`Fetched scene data scene id:${sceneId}; sdk7? ${sceneData.metadata.runtimeVersion === '7'}`)

    // SDK6 scenes support
    if (sceneData.metadata.runtimeVersion !== '7') {
      // sdk6 scene content will be later read by the adaption-layer internally using the Runtime.readFile API
      sdk6SceneContent = sceneData.content
      sdk6FetchComponent = fetch

      const fetchResponse = await fetch.fetch(
        `https://renderer-artifacts.decentraland.org/sdk6-adaption-layer/main/index.js`
      )
      return await fetchResponse.text()
    }

    // SDK7 editor-made scenes support (main.crdt binary file)
    const sceneMainCRDTFileHash = sceneData.content.find(($: any) => $.file === mainCRDTFileName)?.hash
    if (sceneMainCRDTFileHash) {
      const fetchResponse = await fetch.fetch(`${contentFetchBaseUrl}${sceneMainCRDTFileHash}`)
      mainCrdt = new Uint8Array(await fetchResponse.arrayBuffer())
    }

    // Get SDK7 scene main file (index.js/game.js)
    const sceneMainFileHash = sceneData.content.find(($: any) => $.file === sceneData.metadata.main)?.hash
    if (!sceneMainFileHash) {
      throw new Error(`ABORT: Cannot find scene's main asset file.`)
    }
    const fetchResponse = await fetch.fetch(`${contentFetchBaseUrl}${sceneMainFileHash}`)

    return await fetchResponse.text()
  }

  // Local scenes mode only supports SDK7 scenes for now
  async function getGameDataFromLocalScene(scenePath: string): Promise<string> {
    if (!process.env.npm_config_overwrite && existsSync(`${manifestFileDir}/${sceneId}${manifestFileNameEnd}`)) {
      throw new Error(`ABORT: ${sceneId}${manifestFileNameEnd} manifest file already exists.`)
    }

    return readFileSync(scenePath, 'utf-8')
  }

  return {
    getGameDataFromRemoteSceneByCoords,
    getGameDataFromRemoteSceneByID,
    getGameDataFromLocalScene
  }
}
