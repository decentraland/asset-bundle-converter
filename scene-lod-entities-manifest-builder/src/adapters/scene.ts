import { customEvalSdk7 } from '../logic/scene-runtime/sandbox'
import { createModuleRuntime } from '../logic/scene-runtime/sdk7-runtime'
import { setTimeout } from 'timers/promises'
import { initSourcemap } from '../logic/sourcemap'

export const FRAMES_TO_RUN = 91
export let framesCount = 1

export type ISceneComponent = {
  start(hash: string, sourceCode: string): Promise<void>
}

export async function createSceneComponent(): Promise<ISceneComponent> {
  let loaded = false
  let abortController: AbortController

  async function start(hash: string, sourceCode: string) {
    abortController = new AbortController()
    loaded = true
    const runtimeExecutionContext = Object.create(null)
    const sceneModule = createModuleRuntime(runtimeExecutionContext)
    try {
      await customEvalSdk7(sourceCode, runtimeExecutionContext)

      // This only works for scenes that has the sourcemap uploaded inside the .js file or local scenes.
      const sourceMap = await initSourcemap(sourceCode, true)
      //30 FPS
      const updateIntervalMs: number = 33.33

      try {
        await sceneModule.runStart()
      } catch (e: any) {
        console.log('[Start failed]: ', sourceMap.parseError(e))
      }

      // start event loop
      if (sceneModule.exports.onUpdate) {
        // first update always use 0.0 as delta time
        try {
          await sceneModule.runUpdate(0.0)
        } catch (e: any) {
          console.log('[Update failed]: ', sourceMap.parseError(e))
        }
        let start = performance.now()

        while (framesCount < FRAMES_TO_RUN) {
          const now = performance.now()
          const dtMillis = now - start
          start = now

          const dtSecs = dtMillis / 1000

          await sceneModule.runUpdate(dtSecs)

          // wait for next frame
          const ms = Math.max((updateIntervalMs - (performance.now() - start)) | 0, 0)
          await setTimeout(Math.max(ms | 0, 0), undefined, { signal: abortController.signal })
          framesCount++
        }
      }
    } catch (e: any) {
      console.warn(e)
      await stop()
    }
  }

  async function stop() {
    if (loaded) {
      loaded = false
      abortController.abort()
    }
  }

  return {
    start
  }
}
