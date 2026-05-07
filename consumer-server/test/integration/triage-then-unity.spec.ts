// Coverage for the triage → Unity queue split introduced for fast-path
// concurrency. With FAST_PATH_TRIAGE_ENABLED=true the triage loop calls
// executeTriagePass instead of executeConversion. Cache-hit jobs ack from
// the triage queue and never appear on the Unity queue. Cache-miss jobs are
// republished to the Unity queue, which a separate Unity loop drains.

import { createConfigComponent } from '@well-known-components/env-config-provider'
import { createLogComponent } from '@well-known-components/logger'
import { createMetricsComponent } from '@well-known-components/metrics'
import { metricDeclarations } from '../../src/metrics'
import { createMemoryQueueAdapter } from '../../src/adapters/task-queue'
import { createRunnerComponent, IRunnerComponent } from '../../src/adapters/runner'
import { ITaskQueue } from '../../src/adapters/task-queue'
import { IBaseComponent } from '@well-known-components/interfaces'
import { DeploymentToSqs } from '@dcl/schemas/dist/misc/deployments-to-sqs'

jest.mock('../../src/logic/conversion-task', () => ({
  executeConversion: jest.fn(),
  executeLODConversion: jest.fn(),
  executeTriagePass: jest.fn(),
  parseBooleanFlag: jest.requireActual('../../src/logic/conversion-task').parseBooleanFlag
}))

jest.mock('check-disk-space', () => ({
  __esModule: true,
  default: jest.fn(async () => ({ free: 100 * 1e9, size: 200 * 1e9, diskPath: '/' }))
}))

import { executeConversion, executeLODConversion, executeTriagePass } from '../../src/logic/conversion-task'
import { main } from '../../src/service'

const mockedExecuteConversion = executeConversion as jest.Mock
const mockedExecuteLODConversion = executeLODConversion as jest.Mock
const mockedExecuteTriagePass = executeTriagePass as jest.Mock

async function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error('Timed out waiting for queue consumer to advance')
}

describe('when FAST_PATH_TRIAGE_ENABLED is true', () => {
  let runner: IRunnerComponent
  let triageTaskQueue: ITaskQueue<DeploymentToSqs> & IBaseComponent
  let unityTaskQueue: ITaskQueue<DeploymentToSqs> & IBaseComponent
  let publishMessage: jest.Mock

  beforeEach(async () => {
    const config = createConfigComponent({
      PLATFORM: 'windows',
      BUILD_TARGET: 'windows',
      AB_VERSION_WINDOWS: 'v48',
      AB_VERSION_MAC: 'v48',
      AB_VERSION: '',
      FAST_PATH_TRIAGE_ENABLED: 'true'
    })
    const metrics = await createMetricsComponent(metricDeclarations, { config })
    const logs = await createLogComponent({ metrics })

    publishMessage = jest.fn(async () => undefined)
    runner = createRunnerComponent()
    triageTaskQueue = createMemoryQueueAdapter<DeploymentToSqs>({ logs, metrics }, { queueName: 'triage-queue' })
    unityTaskQueue = createMemoryQueueAdapter<DeploymentToSqs>({ logs, metrics }, { queueName: 'unity-queue' })

    const components = {
      config,
      logs,
      server: { use: jest.fn(), setContext: jest.fn() } as any,
      triageTaskQueue,
      unityTaskQueue,
      runner,
      metrics,
      publisher: { publishMessage },
      cdnS3: {} as any,
      sentry: {} as any,
      fetch: {} as any,
      statusChecks: {} as any
    }

    await main({
      components,
      startComponents: async () => {
        await runner.start!({ started: () => true, live: () => true, getComponents: () => ({}) } as any)
      }
    } as any)
  })

  afterEach(async () => {
    const stopRunner = runner.stop()
    await triageTaskQueue.stop!()
    await unityTaskQueue.stop!()
    await stopRunner
    jest.clearAllMocks()
  })

  describe('and a job whose triage outcome is fast-path-completed is enqueued on the triage queue', () => {
    let unityPublishSpy: jest.SpyInstance

    beforeEach(async () => {
      mockedExecuteTriagePass.mockResolvedValue({ kind: 'completed', exitCode: 0 })
      unityPublishSpy = jest.spyOn(unityTaskQueue, 'publish')
      await triageTaskQueue.publish({
        entity: { entityId: 'bafy-fast-hit', authChain: [] as any },
        contentServerUrls: ['https://peer.decentraland.org/content']
      })
      await waitFor(() => mockedExecuteTriagePass.mock.calls.length >= 1)
    })

    it('should call executeTriagePass for the job', () => {
      expect(mockedExecuteTriagePass).toHaveBeenCalledWith(
        expect.anything(),
        'bafy-fast-hit',
        'https://peer.decentraland.org/content',
        undefined,
        undefined,
        'v48'
      )
    })

    it('should not republish the job to the Unity queue', () => {
      expect(unityPublishSpy).not.toHaveBeenCalled()
    })

    it('should not invoke executeConversion (no Unity work)', () => {
      expect(mockedExecuteConversion).not.toHaveBeenCalled()
    })

    it('should publish a finished event with the triage exit code', async () => {
      await waitFor(() => publishMessage.mock.calls.length >= 1)
      expect(publishMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          metadata: expect.objectContaining({ entityId: 'bafy-fast-hit', statusCode: 0 })
        })
      )
    })
  })

  describe('and a job whose triage outcome is needs-unity is enqueued on the triage queue', () => {
    let unityPublishSpy: jest.SpyInstance

    beforeEach(async () => {
      mockedExecuteTriagePass.mockResolvedValue({ kind: 'needs-unity' })
      mockedExecuteConversion.mockResolvedValue(0)
      unityPublishSpy = jest.spyOn(unityTaskQueue, 'publish')
      await triageTaskQueue.publish({
        entity: { entityId: 'bafy-cache-miss', authChain: [] as any },
        contentServerUrls: ['https://peer.decentraland.org/content']
      })
      await waitFor(() => unityPublishSpy.mock.calls.length >= 1)
    })

    it('should republish the job to the Unity queue', () => {
      expect(unityPublishSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          entity: expect.objectContaining({ entityId: 'bafy-cache-miss' })
        }),
        false
      )
    })

    it('should drive the Unity loop to call executeConversion', async () => {
      await waitFor(() => mockedExecuteConversion.mock.calls.length >= 1)
      expect(mockedExecuteConversion).toHaveBeenCalledWith(
        expect.anything(),
        'bafy-cache-miss',
        'https://peer.decentraland.org/content',
        undefined,
        undefined,
        undefined,
        'v48'
      )
    })
  })

  describe('and a LOD job is enqueued on the triage queue', () => {
    let unityPublishSpy: jest.SpyInstance

    beforeEach(async () => {
      mockedExecuteLODConversion.mockResolvedValue(0)
      unityPublishSpy = jest.spyOn(unityTaskQueue, 'publish')
      await triageTaskQueue.publish({
        entity: { entityId: 'bafy-lod-job', authChain: [] as any },
        contentServerUrls: ['https://peer.decentraland.org/content'],
        lods: ['lod1.glb']
      } as any)
      await waitFor(() => unityPublishSpy.mock.calls.length >= 1)
    })

    it('should republish the LOD job to the Unity queue without probing', () => {
      expect(mockedExecuteTriagePass).not.toHaveBeenCalled()
      expect(unityPublishSpy).toHaveBeenCalledTimes(1)
    })

    it('should drive the Unity loop to call executeLODConversion', async () => {
      await waitFor(() => mockedExecuteLODConversion.mock.calls.length >= 1)
      expect(mockedExecuteLODConversion).toHaveBeenCalledWith(
        expect.anything(),
        'bafy-lod-job',
        ['lod1.glb'],
        'v48'
      )
    })
  })

  describe('and a triage-failed outcome is returned', () => {
    let unityPublishSpy: jest.SpyInstance

    beforeEach(async () => {
      mockedExecuteTriagePass.mockResolvedValue({ kind: 'failed', exitCode: 5 })
      unityPublishSpy = jest.spyOn(unityTaskQueue, 'publish')
      await triageTaskQueue.publish({
        entity: { entityId: 'bafy-failed-probe', authChain: [] as any },
        contentServerUrls: ['https://peer.decentraland.org/content']
      })
      await waitFor(() => publishMessage.mock.calls.length >= 1)
    })

    it('should publish a finished event with the failure status code', () => {
      expect(publishMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          metadata: expect.objectContaining({ entityId: 'bafy-failed-probe', statusCode: 5 })
        })
      )
    })

    it('should not republish to the Unity queue', () => {
      expect(unityPublishSpy).not.toHaveBeenCalled()
    })
  })
})

describe('when FAST_PATH_TRIAGE_ENABLED is unset (default off)', () => {
  let runner: IRunnerComponent
  let triageTaskQueue: ITaskQueue<DeploymentToSqs> & IBaseComponent
  let unityTaskQueue: ITaskQueue<DeploymentToSqs> & IBaseComponent
  let publishMessage: jest.Mock

  beforeEach(async () => {
    mockedExecuteConversion.mockResolvedValue(0)

    const config = createConfigComponent({
      PLATFORM: 'windows',
      BUILD_TARGET: 'windows',
      AB_VERSION_WINDOWS: 'v48',
      AB_VERSION_MAC: 'v48',
      AB_VERSION: ''
    })
    const metrics = await createMetricsComponent(metricDeclarations, { config })
    const logs = await createLogComponent({ metrics })

    publishMessage = jest.fn(async () => undefined)
    runner = createRunnerComponent()
    triageTaskQueue = createMemoryQueueAdapter<DeploymentToSqs>({ logs, metrics }, { queueName: 'triage-queue' })
    unityTaskQueue = createMemoryQueueAdapter<DeploymentToSqs>({ logs, metrics }, { queueName: 'unity-queue' })

    const components = {
      config,
      logs,
      server: { use: jest.fn(), setContext: jest.fn() } as any,
      triageTaskQueue,
      unityTaskQueue,
      runner,
      metrics,
      publisher: { publishMessage },
      cdnS3: {} as any,
      sentry: {} as any,
      fetch: {} as any,
      statusChecks: {} as any
    }

    await main({
      components,
      startComponents: async () => {
        await runner.start!({ started: () => true, live: () => true, getComponents: () => ({}) } as any)
      }
    } as any)
  })

  afterEach(async () => {
    const stopRunner = runner.stop()
    await triageTaskQueue.stop!()
    await unityTaskQueue.stop!()
    await stopRunner
    jest.clearAllMocks()
  })

  describe('and a job is enqueued on the triage queue', () => {
    let unityPublishSpy: jest.SpyInstance

    beforeEach(async () => {
      unityPublishSpy = jest.spyOn(unityTaskQueue, 'publish')
      await triageTaskQueue.publish({
        entity: { entityId: 'bafy-default-mode', authChain: [] as any },
        contentServerUrls: ['https://peer.decentraland.org/content']
      })
      await waitFor(() => mockedExecuteConversion.mock.calls.length >= 1)
    })

    it('should call executeConversion directly (today behavior)', () => {
      expect(mockedExecuteConversion).toHaveBeenCalledWith(
        expect.anything(),
        'bafy-default-mode',
        'https://peer.decentraland.org/content',
        undefined,
        undefined,
        undefined,
        'v48'
      )
    })

    it('should not call executeTriagePass', () => {
      expect(mockedExecuteTriagePass).not.toHaveBeenCalled()
    })

    it('should not republish to the Unity queue', () => {
      expect(unityPublishSpy).not.toHaveBeenCalled()
    })
  })
})
