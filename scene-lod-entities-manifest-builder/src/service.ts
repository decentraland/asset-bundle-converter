import { Lifecycle } from '@well-known-components/interfaces'
import { BaseComponents } from './types'
import { loadOrReload } from './logic/sceneLoader'

// this function wires the business logic (adapters & controllers) with the components (ports)
export async function main(program: Lifecycle.EntryPointParameters<BaseComponents>) {
  const { components, startComponents } = program

  // start ports: db, listeners, synchronizations, etc
  await startComponents()
  
  const localPath = process.env.npm_config_path ?? await components.config.getString('LOCAL_SCENE_PATH')
  if (localPath) {
    await loadOrReload(components, 'localScene', localPath, false)
  } else {
    const sceneID = process.env.npm_config_sceneID
    if (sceneID) {
      await loadOrReload(components, 'remoteScene', sceneID, true)
    }else{
      const remoteSceneCoords = process.env.npm_config_coords ?? await components.config.getString('REMOTE_SCENE_COORDS')
      if (remoteSceneCoords) {
        await loadOrReload(components, 'remoteScene', remoteSceneCoords, false)
      }
    }
    

  }
}
