// Coverage for the triage → Conversion queue split introduced for fast-path
// concurrency. With FAST_PATH_TRIAGE_ENABLED=true the triage loop calls
// executeTriagePass instead of executeConversion. Cache-hit jobs ack from
// the triage queue and never appear on the Conversion queue. Cache-miss jobs are
// republished to the Conversion queue, which a separate conversion loop drains.

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
import { createConversionOrchestratorComponent } from '../../src/logic/conversion-orchestrator'
import { createCatalystMock, createScenesMock, createUnityRunnerMock } from '../mocks'

jest.mock('../../src/logic/conversion-task', () => ({
  executeConversion: jest.fn(),
  executeLODConversion: jest.fn(),
  executeTriagePass: jest.fn(),
  parseBooleanFlag: jest.requireActual('../../src/logic/conversion-task').parseBooleanFlag
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

// Filesystem stub: never reports below-minimum so the consumer loops never
// trigger the graceful-stop path. Tests don't need actual disk introspection.
const stubFilesystem = (): IFilesystemComponent => ({
  getFreeBytes: jest.fn(async () => 100 * 1e9),
  isBelowMinimum: jest.fn(async () => false)
})

describe('when FAST_PATH_TRIAGE_ENABLED is true', () => {
  let runner: IRunnerComponent
  let triageTaskQueue: ITaskQueue<DeploymentToSqs> & IBaseComponent
  let conversionTaskQueue: ITaskQueue<DeploymentToSqs> & IBaseComponent
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
    conversionTaskQueue = createMemoryQueueAdapter<DeploymentToSqs>({ logs, metrics }, { queueName: 'conversion-queue' })
    const filesystem = stubFilesystem()
    // Build the real orchestrator against the mocked conversion-task module —
    // that way the dispatch logic (validation guard, fast-path / republish
    // routing, finished-event publication) gets exercised, while Unity and
    // catalyst calls stay mocked.
    const conversionOrchestrator = await createConversionOrchestratorComponent({
      logs,
      metrics,
      config,
      cdnS3: {} as any,
      sentry: {} as any,
      conversionTaskQueue,
      publisher: { publishMessage },
      // executeConversion / executeLODConversion / executeTriagePass are
      // jest.mocked at module scope, so the orchestrator never dispatches into
      // catalyst, unity-runner, or scenes. Factory mocks satisfy the type
      // contract.
      catalyst: createCatalystMock(),
      unityRunner: createUnityRunnerMock(),
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
    const stopRunner = runner.stop()
    await triageTaskQueue.stop!()
    await conversionTaskQueue.stop!()
    await stopRunner
    jest.clearAllMocks()
  })

  describe('and a job whose triage outcome is fast-path-completed is enqueued on the triage queue', () => {
    let conversionPublishSpy: jest.SpyInstance

    beforeEach(async () => {
      mockedExecuteTriagePass.mockResolvedValue({ kind: 'completed', exitCode: 0 })
      conversionPublishSpy = jest.spyOn(conversionTaskQueue, 'publish')
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

    it('should not republish the job to the Conversion queue', () => {
      expect(conversionPublishSpy).not.toHaveBeenCalled()
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
    let conversionPublishSpy: jest.SpyInstance

    beforeEach(async () => {
      mockedExecuteTriagePass.mockResolvedValue({ kind: 'needs-unity' })
      mockedExecuteConversion.mockResolvedValue(0)
      conversionPublishSpy = jest.spyOn(conversionTaskQueue, 'publish')
      await triageTaskQueue.publish({
        entity: { entityId: 'bafy-cache-miss', authChain: [] as any },
        contentServerUrls: ['https://peer.decentraland.org/content']
      })
      await waitFor(() => conversionPublishSpy.mock.calls.length >= 1)
    })

    it('should republish the job to the Conversion queue', () => {
      expect(conversionPublishSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          entity: expect.objectContaining({ entityId: 'bafy-cache-miss' })
        }),
        false
      )
    })

    it('should drive the conversion loop to call executeConversion', async () => {
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
    let conversionPublishSpy: jest.SpyInstance

    beforeEach(async () => {
      mockedExecuteLODConversion.mockResolvedValue(0)
      conversionPublishSpy = jest.spyOn(conversionTaskQueue, 'publish')
      await triageTaskQueue.publish({
        entity: { entityId: 'bafy-lod-job', authChain: [] as any },
        contentServerUrls: ['https://peer.decentraland.org/content'],
        lods: ['lod1.glb']
      } as any)
      await waitFor(() => conversionPublishSpy.mock.calls.length >= 1)
    })

    it('should republish the LOD job to the Conversion queue without probing', () => {
      expect(mockedExecuteTriagePass).not.toHaveBeenCalled()
      expect(conversionPublishSpy).toHaveBeenCalledTimes(1)
    })

    it('should drive the conversion loop to call executeLODConversion', async () => {
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
    let conversionPublishSpy: jest.SpyInstance

    beforeEach(async () => {
      mockedExecuteTriagePass.mockResolvedValue({ kind: 'failed', exitCode: 5 })
      conversionPublishSpy = jest.spyOn(conversionTaskQueue, 'publish')
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

    it('should not republish to the Conversion queue', () => {
      expect(conversionPublishSpy).not.toHaveBeenCalled()
    })
  })

  describe('and a force=true job is enqueued on the triage queue', () => {
    let conversionPublishSpy: jest.SpyInstance

    beforeEach(async () => {
      // executeTriagePass returns needs-unity for force=true (verified in
      // execute-triage-pass.spec.ts unit tests). Here we verify the routing
      // half of the contract: the job is republished to the Conversion queue and
      // the original force flag is preserved on the republished payload.
      mockedExecuteTriagePass.mockResolvedValue({ kind: 'needs-unity' })
      mockedExecuteConversion.mockResolvedValue(0)
      conversionPublishSpy = jest.spyOn(conversionTaskQueue, 'publish')
      await triageTaskQueue.publish({
        entity: { entityId: 'bafy-force-job', authChain: [] as any },
        contentServerUrls: ['https://peer.decentraland.org/content'],
        force: true
      } as any)
      await waitFor(() => conversionPublishSpy.mock.calls.length >= 1)
    })

    it('should republish the job to the Conversion queue with force preserved', () => {
      expect(conversionPublishSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          entity: expect.objectContaining({ entityId: 'bafy-force-job' }),
          force: true
        }),
        false
      )
    })

    it('should drive the conversion loop to call executeConversion with force=true', async () => {
      await waitFor(() => mockedExecuteConversion.mock.calls.length >= 1)
      expect(mockedExecuteConversion).toHaveBeenCalledWith(
        expect.anything(),
        'bafy-force-job',
        'https://peer.decentraland.org/content',
        true,
        undefined,
        undefined,
        'v48'
      )
    })
  })

  describe('and a priority job is enqueued on the triage queue', () => {
    let conversionPublishSpy: jest.SpyInstance

    beforeEach(async () => {
      // The in-memory adapter now honours `prioritize` on publish so we can
      // verify the priority lane end-to-end. The cache-miss path triggers
      // the republish so we can assert isPriority is forwarded correctly.
      mockedExecuteTriagePass.mockResolvedValue({ kind: 'needs-unity' })
      mockedExecuteConversion.mockResolvedValue(0)
      conversionPublishSpy = jest.spyOn(conversionTaskQueue, 'publish')
      await triageTaskQueue.publish(
        {
          entity: { entityId: 'bafy-priority-job', authChain: [] as any },
          contentServerUrls: ['https://peer.decentraland.org/content']
        },
        true /* prioritize */
      )
      await waitFor(() => conversionPublishSpy.mock.calls.length >= 1)
    })

    it('should republish to the Conversion queue with prioritize=true', () => {
      expect(conversionPublishSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          entity: expect.objectContaining({ entityId: 'bafy-priority-job' })
        }),
        true
      )
    })
  })

  describe('and a job with no contentServerUrls is enqueued on the triage queue', () => {
    let conversionPublishSpy: jest.SpyInstance

    beforeEach(async () => {
      // Force a fast-path completion on the trailing valid job so we know
      // the loop advanced past the malformed one without invoking the
      // republish path. (Without explicit mockResolvedValue here, the mock
      // implementation can leak from prior describe blocks since
      // jest.clearAllMocks doesn't clear mockResolvedValue — only calls.)
      mockedExecuteTriagePass.mockResolvedValue({ kind: 'completed', exitCode: 0 })
      conversionPublishSpy = jest.spyOn(conversionTaskQueue, 'publish')
      // Malformed non-LOD job (no contentServerUrls) — should be skipped by
      // the validation guard before any of the conversion paths fire.
      await triageTaskQueue.publish({
        entity: { entityId: 'bafy-malformed', authChain: [] as any }
      } as any)
      // Valid job behind it confirms the loop advanced past the skip.
      await triageTaskQueue.publish({
        entity: { entityId: 'bafy-valid-after-malformed', authChain: [] as any },
        contentServerUrls: ['https://peer.decentraland.org/content']
      })
      await waitFor(() => mockedExecuteTriagePass.mock.calls.length >= 1)
    })

    it('should skip the malformed job and process the valid one only', () => {
      expect(mockedExecuteTriagePass).toHaveBeenCalledTimes(1)
      expect(mockedExecuteTriagePass).toHaveBeenCalledWith(
        expect.anything(),
        'bafy-valid-after-malformed',
        'https://peer.decentraland.org/content',
        undefined,
        undefined,
        'v48'
      )
    })

    it('should not republish either job to the Conversion queue (malformed skipped, valid took fast-path)', () => {
      expect(conversionPublishSpy).not.toHaveBeenCalled()
    })
  })
})

describe('when FAST_PATH_TRIAGE_ENABLED is unset (default off)', () => {
  let runner: IRunnerComponent
  let triageTaskQueue: ITaskQueue<DeploymentToSqs> & IBaseComponent
  let conversionTaskQueue: ITaskQueue<DeploymentToSqs> & IBaseComponent
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
    conversionTaskQueue = createMemoryQueueAdapter<DeploymentToSqs>({ logs, metrics }, { queueName: 'conversion-queue' })
    const filesystem = stubFilesystem()
    const conversionOrchestrator = await createConversionOrchestratorComponent({
      logs,
      metrics,
      config,
      cdnS3: {} as any,
      sentry: {} as any,
      conversionTaskQueue,
      publisher: { publishMessage },
      // executeConversion / executeLODConversion / executeTriagePass are
      // jest.mocked at module scope, so the orchestrator never dispatches into
      // catalyst, unity-runner, or scenes. Factory mocks satisfy the type
      // contract.
      catalyst: createCatalystMock(),
      unityRunner: createUnityRunnerMock(),
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
    const stopRunner = runner.stop()
    await triageTaskQueue.stop!()
    await conversionTaskQueue.stop!()
    await stopRunner
    jest.clearAllMocks()
  })

  describe('and a job is enqueued on the triage queue', () => {
    let conversionPublishSpy: jest.SpyInstance

    beforeEach(async () => {
      conversionPublishSpy = jest.spyOn(conversionTaskQueue, 'publish')
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

    it('should not republish to the Conversion queue', () => {
      expect(conversionPublishSpy).not.toHaveBeenCalled()
    })
  })
})
