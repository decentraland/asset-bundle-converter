import { IBaseComponent } from '@well-known-components/interfaces'

export type RunnerComponentArg = {
  readonly isRunning: boolean
}

export type IRunnerComponent = IBaseComponent & {
  runTask(delegate: (opt: RunnerComponentArg) => Promise<void>): void
}

// this component runs a loop while the application is enabled. and waits until it
// finishes the loop to stop the service
export function createRunnerComponent(): IRunnerComponent {
  const delegates: Promise<any>[] = []
  let isRunning = false

  return {
    async start() {
      if (isRunning) throw new Error('Cannot run twice')
      isRunning = true
    },
    async stop() {
      isRunning = false
      await Promise.all(delegates)
    },
    runTask(delegate) {
      if (!isRunning) throw new Error('You can only run tasks while the component is running')
      delegates.push(
        delegate({
          get isRunning() {
            return isRunning
          }
        })
      )
    }
  }
}
