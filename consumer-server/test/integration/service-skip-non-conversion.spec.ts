// Regression coverage for the queue-consumer guard in service.ts: jobs that
// arrive without `entity.entityId` (e.g. world_undeployment payloads that leak
// into the SQS topic) must be skipped without invoking the conversion path or
// publishing a finished event, AND must not block subsequent valid jobs.

import { createConfigComponent } from '@well-known-components/env-config-provider'
import { createLogComponent } from '@well-known-components/logger'
import { createMetricsComponent } from '@well-known-components/metrics'
import { metricDeclarations } from '../../src/metrics'
import { createMemoryQueueAdapter } from '../../src/adapters/task-queue'
import { createRunnerComponent, IRunnerComponent } from '../../src/adapters/runner'
import { ITaskQueue } from '../../src/adapters/task-queue'
import { IBaseComponent } from '@well-known-components/interfaces'
import { DeploymentToSqs } from '@dcl/schemas/dist/misc/deployments-to-sqs'
import { IFilesystemComponent } from '../../src/adapters/filesystem'
import { createCatalystMock, createScenesMock, createUnityRunnerMock } from '../mocks'
import { createConversionOrchestratorComponent } from '../../src/logic/conversion-orchestrator'

jest.mock('../../src/logic/conversion-task', () => ({
  executeConversion: jest.fn(),
  executeLODConversion: jest.fn(),
  executeTriagePass: jest.fn(),
  // Preserve the real parseBooleanFlag — the orchestrator reads it at startup
  // to decide whether the triage loop calls executeTriagePass or executeConversion.
  // Without this, FAST_PATH_TRIAGE_ENABLED parsing throws on construction.
  parseBooleanFlag: jest.requireActual('../../src/logic/conversion-task').parseBooleanFlag
}))

import { executeConversion, executeLODConversion } from '../../src/logic/conversion-task'
import { main } from '../../src/service'

const mockedExecuteConversion = executeConversion as jest.Mock
const mockedExecuteLODConversion = executeLODConversion as jest.Mock

async function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error('Timed out waiting for queue consumer to advance')
}

describe('when the conversion worker consumes a job from the queue', () => {
  let runner: IRunnerComponent
  let triageTaskQueue: ITaskQueue<DeploymentToSqs> & IBaseComponent
  let conversionTaskQueue: ITaskQueue<DeploymentToSqs> & IBaseComponent
  let publishMessage: jest.Mock

  beforeEach(async () => {
    mockedExecuteConversion.mockResolvedValue(0)
    mockedExecuteLODConversion.mockResolvedValue(0)

    const config = createConfigComponent({
      PLATFORM: 'windows',
      BUILD_TARGET: 'windows',
      AB_VERSION_WINDOWS: 'v48',
      AB_VERSION_MAC: 'v48',
      AB_VERSION: '',
      ALLOWED_CONTENT_SERVER_HOSTS: 'peer.decentraland.org'
    })
    const metrics = await createMetricsComponent(metricDeclarations, { config })
    const logs = await createLogComponent({ metrics })

    publishMessage = jest.fn(async () => undefined)
    runner = createRunnerComponent()
    triageTaskQueue = createMemoryQueueAdapter<DeploymentToSqs>({ logs, metrics }, { queueName: 'test-triage-queue' })
    conversionTaskQueue = createMemoryQueueAdapter<DeploymentToSqs>({ logs, metrics }, { queueName: 'test-unity-queue' })
    const filesystem: IFilesystemComponent = {
      getFreeBytes: jest.fn(async () => 100 * 1e9),
      isBelowMinimum: jest.fn(async () => false)
    }
    const conversionOrchestrator = await createConversionOrchestratorComponent({
      logs,
      metrics,
      config,
      cdnS3: {} as any,
      sentry: {} as any,
      conversionTaskQueue,
      publisher: { publishMessage },
      // Stubs — executeConversion / executeLODConversion are jest.mocked at
      // module scope so the orchestrator never dispatches into these.
      catalyst: createCatalystMock(),
      unityRunner: createUnityRunnerMock(),
      sceneConverter: {} as any,
      assetBundleEncoder: {} as any,
      // executeConversion / executeLODConversion are jest.mocked at module
      // scope; scenes is reachable only through them. The factory mock is
      // here for type-shape satisfaction.
      scenes: createScenesMock()
    })

    const components = {
      config,
      logs,
      server: { use: jest.fn(), setContext: jest.fn() } as any,
      triageTaskQueue,
      conversionTaskQueue,
      runner,
      metrics,
      publisher: { publishMessage },
      cdnS3: {} as any,
      sentry: {} as any,
      fetch: {} as any,
      statusChecks: {} as any,
      filesystem,
      conversionOrchestrator
    }

    await main({
      components,
      startComponents: async () => {
        await runner.start!({ started: () => true, live: () => true, getComponents: () => ({}) } as any)
      }
    } as any)
  })

  afterEach(async () => {
    // Stop runner first to flip isRunning=false; then close both queues so the
    // pending consumeAndProcessJob calls (one per loop) resolve and the loops
    // can exit.
    const stopRunner = runner.stop()
    await triageTaskQueue.stop!()
    await conversionTaskQueue.stop!()
    await stopRunner
    jest.clearAllMocks()
  })

  describe('and the job is a non-conversion payload missing entity.entityId (e.g. world_undeployment)', () => {
    beforeEach(async () => {
      // Publish the malformed job, then a valid job behind it. When the valid
      // job has been processed we know the malformed one has been dequeued too
      // (the in-memory queue is FIFO and serial), so we can assert what the
      // worker did — and didn't — do for each.
      await triageTaskQueue.publish({ type: 'world_undeployment' } as any)
      await triageTaskQueue.publish({
        entity: { entityId: 'bafyvalidafterskip', authChain: [] as any },
        contentServerUrls: ['https://peer.decentraland.org/content']
      })
      await waitFor(() => mockedExecuteConversion.mock.calls.length >= 1)
    })

    it('should call executeConversion only once — for the valid job, not the skipped one', () => {
      expect(mockedExecuteConversion).toHaveBeenCalledTimes(1)
    })

    it('should pass the valid job entity id to executeConversion', () => {
      expect(mockedExecuteConversion).toHaveBeenCalledWith(
        expect.anything(),
        'bafyvalidafterskip',
        'https://peer.decentraland.org/content',
        undefined,
        undefined,
        undefined,
        'v48'
      )
    })

    it('should not invoke the LOD conversion path for the skipped job', () => {
      expect(mockedExecuteLODConversion).not.toHaveBeenCalled()
    })

    it('should publish exactly one finished event — for the valid job, not the skipped one', () => {
      expect(publishMessage).toHaveBeenCalledTimes(1)
      expect(publishMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          metadata: expect.objectContaining({ entityId: 'bafyvalidafterskip' })
        })
      )
    })
  })

  describe('and the job has an entity but the entityId is an empty string', () => {
    beforeEach(async () => {
      await triageTaskQueue.publish({ entity: { entityId: '', authChain: [] as any } } as any)
      await triageTaskQueue.publish({
        entity: { entityId: 'bafyvalidafterempty', authChain: [] as any },
        contentServerUrls: ['https://peer.decentraland.org/content']
      })
      await waitFor(() => mockedExecuteConversion.mock.calls.length >= 1)
    })

    it('should treat the empty entityId as not-a-conversion-job and skip it', () => {
      expect(mockedExecuteConversion).toHaveBeenCalledTimes(1)
      expect(mockedExecuteConversion).toHaveBeenCalledWith(
        expect.anything(),
        'bafyvalidafterempty',
        expect.any(String),
        undefined,
        undefined,
        undefined,
        'v48'
      )
    })
  })
})
