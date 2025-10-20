import { LoadableApis } from './apis'

type GenericRpcModule = Record<string, (...args: any) => Promise<unknown>>

type SceneInterface = {
  onUpdate(dt: number): Promise<void>
  onStart(): Promise<void>
}

type SDK7Module = {
  readonly exports: Partial<SceneInterface>
  runStart(): Promise<void>
  runUpdate(deltaTime: number): Promise<void>
}

class WebSocket {
  constructor(url: string) {
    this.url = url
  }
  onmessage() {}
  send() {}
  onclose() {}
  onerror() {}
  onopen() {}
  close(_code?: number, _reason?: string) {}
  readonly url
  readonly readyState = 0
  readonly CLOSED = 1
  readonly CLOSING = 0
  readonly CONNECTING = 0
  readonly OPEN = 0
}

const a = new WebSocket('ws://')
a.onmessage = () => {}

export function createModuleRuntime(runtime: Record<string, any>): SDK7Module {
  const exports: Partial<SceneInterface> = {}

  const module = { exports }

  Object.defineProperty(runtime, 'module', {
    configurable: false,
    get() {
      return module
    }
  })

  Object.defineProperty(runtime, 'exports', {
    configurable: false,
    get() {
      return module.exports
    }
  })

  // We don't want to log the scene logs
  Object.defineProperty(runtime, 'console', {
    value: {
      log: () => {},
      info: () => {},
      debug: () => {},
      trace: () => {},
      warning: () => {},
      error: () => {}
    }
  })

  Object.defineProperty(runtime, 'fetch', {
    value: async (_url: string, _init: any) => {
      return {
        status: 200,
        json: async () => {},
        text: async () => ''
      }
    }
  })

  Object.defineProperty(runtime, 'WebSocket', {
    value: WebSocket
  })

  const loadedModules: Record<string, GenericRpcModule> = {}

  Object.defineProperty(runtime, 'require', {
    configurable: false,
    value: (moduleName: string) => {
      if (moduleName in loadedModules) return loadedModules[moduleName]
      const module = loadSceneModule(moduleName)
      loadedModules[moduleName] = module
      return module
    }
  })

  const setImmediateList: Array<() => Promise<void>> = []

  Object.defineProperty(runtime, 'setImmediate', {
    configurable: false,
    value: (fn: () => Promise<void>) => {
      setImmediateList.push(fn)
    }
  })

  async function runSetImmediate(): Promise<void> {
    if (setImmediateList.length) {
      for (const fn of setImmediateList) {
        try {
          await fn()
        } catch (err: any) {
          console.error(err)
        }
      }
      setImmediateList.length = 0
    }
  }

  return {
    get exports() {
      return module.exports
    },
    async runStart() {
      if (module.exports.onStart) {
        await module.exports.onStart()
      }
      await runSetImmediate()
    },
    async runUpdate(deltaTime: number) {
      if (module.exports.onUpdate) {
        await module.exports.onUpdate(deltaTime)
      }
      await runSetImmediate()
    }
  }
}

function loadSceneModule(moduleName: string): GenericRpcModule {
  const moduleToLoad = moduleName.replace(/^~system\//, '')
  if (moduleToLoad in LoadableApis) {
    return (LoadableApis as any)[moduleToLoad]
  } else {
    throw new Error(`Unknown module ${moduleName}`)
  }
}
