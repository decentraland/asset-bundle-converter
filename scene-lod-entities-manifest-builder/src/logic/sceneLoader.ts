import { createSceneComponent } from '../adapters/scene'
import { BaseComponents } from '../types'

export async function loadOrReload({ sceneFetcher }: BaseComponents, loadingType: string, targetScene: string, doneBySceneID : boolean) {
  let hash: string
  let sourceCode: string
  if (loadingType === 'localScene') {
    sourceCode = await sceneFetcher.getGameDataFromLocalScene(targetScene)
    hash = 'localScene'
  } else {
    if(doneBySceneID){
      sourceCode = await sceneFetcher.getGameDataFromRemoteSceneByID(targetScene)
    }else{
      sourceCode = await sceneFetcher.getGameDataFromRemoteSceneByCoords(targetScene)
    }
    hash = 'remoteScene'
  }

  const scene = await createSceneComponent()
  console.log(`${loadingType} source code loaded, starting scene`)
  await scene.start(hash, sourceCode).catch(console.error)
  console.log(`Finished running frames!`)
  
}
