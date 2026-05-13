// Unit coverage for the conversion-orchestrator dispatch logic. The
// integration tests at test/integration/triage-then-conversion.spec.ts and
// test/integration/service-skip-non-conversion.spec.ts wire the orchestrator
// through `main()` and the queue adapters; this file targets the per-method
// behaviour directly so a regression in the dispatch tree is caught at the
// unit level (faster feedback, no queue plumbing in the trace).

import { createConfigComponent } from '@well-known-components/env-config-provider'
import { createLogComponent } from '@well-known-components/logger'
import { createMetricsComponent } from '@well-known-components/metrics'
import { metricDeclarations } from '../../src/metrics'
import { DeploymentToSqs } from '@dcl/schemas/dist/misc/deployments-to-sqs'
import {
  createCatalystMock,
  createPublisherMock,
  createScenesMock,
  createUnityRunnerMock,
  MockedPublisherComponent,
  MockedScenesComponent
} from '../mocks'

jest.mock('../../src/logic/conversion-task', () => ({
  executeConversion: jest.fn(),
  executeLODConversion: jest.fn(),
  executeTriagePass: jest.fn(),
  parseBooleanFlag: jest.requireActual('../../src/logic/conversion-task').parseBooleanFlag
}))

import { executeConversion, executeLODConversion, executeTriagePass } from '../../src/logic/conversion-task'
import {
  createConversionOrchestratorComponent,
  IConversionOrchestratorComponent
} from '../../src/logic/conversion-orchestrator'

const mockedExecuteConversion = executeConversion as jest.Mock
const mockedExecuteLODConversion = executeLODConversion as jest.Mock
const mockedExecuteTriagePass = executeTriagePass as jest.Mock

type Harness = {
  orchestrator: IConversionOrchestratorComponent
  publisher: MockedPublisherComponent
  scenes: MockedScenesComponent
  conversionPublish: jest.Mock
}

async function buildHarness(opts: { triageEnabled: boolean }): Promise<Harness> {
  const config = createConfigComponent({
    PLATFORM: 'windows',
    BUILD_TARGET: 'windows',
    AB_VERSION_WINDOWS: 'v48',
    AB_VERSION_MAC: 'v48',
    AB_VERSION: '',
    FAST_PATH_TRIAGE_ENABLED: opts.triageEnabled ? 'true' : 'false'
  })
  const metrics = await createMetricsComponent(metricDeclarations, { config })
  const logs = await createLogComponent({ metrics })
  const conversionPublish: jest.Mock = jest.fn(async () => ({ id: 'unity-msg-1' }))
  const conversionTaskQueue = { publish: conversionPublish, consumeAndProcessJob: jest.fn() } as any
  const publisher = createPublisherMock()
  // This harness jest.mocks executeConversion/Triage/LOD at module scope, so
  // dispatch never reaches scenes.*; the mock is constructed for type-shape
  // satisfaction. Individual tests assert non-invocation where it matters.
  const scenes = createScenesMock()

  const orchestrator = await createConversionOrchestratorComponent({
    logs,
    metrics,
    config,
    cdnS3: {} as any,
    sentry: {} as any,
    conversionTaskQueue,
    publisher,
    catalyst: createCatalystMock(),
    unityRunner: createUnityRunnerMock(),
    scenes
  })

  return { orchestrator, publisher, scenes, conversionPublish }
}

function buildValidSceneJob(): DeploymentToSqs {
  return {
    entity: { entityId: 'bafy-scene', authChain: [] as any },
    contentServerUrls: ['https://peer.decentraland.org/content']
  } as any
}

function buildValidLodJob(): DeploymentToSqs {
  return {
    entity: { entityId: 'bafy-lod', authChain: [] as any },
    contentServerUrls: ['https://peer.decentraland.org/content'],
    lods: ['lod-1.glb', 'lod-2.glb']
  } as any
}

describe('when processIncomingJob is called and FAST_PATH_TRIAGE_ENABLED is false', () => {
  let harness: Harness
  let validSceneJob: DeploymentToSqs
  let validLodJob: DeploymentToSqs

  beforeEach(async () => {
    harness = await buildHarness({ triageEnabled: false })
    validSceneJob = buildValidSceneJob()
    validLodJob = buildValidLodJob()
  })

  afterEach(() => {
    jest.clearAllMocks()
  })

  describe('and the job has no entity.entityId', () => {
    beforeEach(async () => {
      await harness.orchestrator.processIncomingJob({ type: 'world_undeployment' } as any, false)
    })

    it('should not call executeConversion', () => {
      expect(mockedExecuteConversion).not.toHaveBeenCalled()
    })

    it('should not publish a finished event', () => {
      expect(harness.publisher.publishMessage).not.toHaveBeenCalled()
    })
  })

  describe('and the job has an entityId but no contentServerUrls', () => {
    beforeEach(async () => {
      await harness.orchestrator.processIncomingJob(
        { entity: { entityId: 'bafy-noUrls', authChain: [] as any } } as any,
        false
      )
    })

    it('should skip the job (validation guard rejects empty contentServerUrls)', () => {
      expect(mockedExecuteConversion).not.toHaveBeenCalled()
      expect(harness.publisher.publishMessage).not.toHaveBeenCalled()
    })
  })

  describe('and the job is a regular scene', () => {
    beforeEach(async () => {
      mockedExecuteConversion.mockResolvedValueOnce(0)
      await harness.orchestrator.processIncomingJob(validSceneJob, false)
    })

    it('should call executeConversion with the entity and content server URL', () => {
      expect(mockedExecuteConversion).toHaveBeenCalledWith(
        expect.anything(),
        'bafy-scene',
        'https://peer.decentraland.org/content',
        undefined,
        undefined,
        undefined,
        'v48'
      )
    })

    it('should publish a finished event with the conversion exit code', () => {
      expect(harness.publisher.publishMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          metadata: expect.objectContaining({ entityId: 'bafy-scene', statusCode: 0 })
        })
      )
    })
  })

  describe('and the job has a lods array', () => {
    beforeEach(async () => {
      mockedExecuteLODConversion.mockResolvedValueOnce(0)
      await harness.orchestrator.processIncomingJob(validLodJob, false)
    })

    it('should call executeLODConversion (not executeConversion)', () => {
      expect(mockedExecuteLODConversion).toHaveBeenCalledWith(
        expect.anything(),
        'bafy-lod',
        ['lod-1.glb', 'lod-2.glb'],
        'v48'
      )
      expect(mockedExecuteConversion).not.toHaveBeenCalled()
    })

    it('should publish a finished event with isLods=true', () => {
      expect(harness.publisher.publishMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          metadata: expect.objectContaining({ isLods: true, entityId: 'bafy-lod' })
        })
      )
    })
  })

  describe('and the job has doISS=true', () => {
    beforeEach(async () => {
      mockedExecuteConversion.mockResolvedValueOnce(0)
      await harness.orchestrator.processIncomingJob({ ...validSceneJob, doISS: true } as any, false)
    })

    it('should pass v2004 as the version (legacy ISS path)', () => {
      const callArgs = mockedExecuteConversion.mock.calls[0]
      expect(callArgs[6]).toBe('v2004')
    })
  })
})

describe('when processIncomingJob is called and FAST_PATH_TRIAGE_ENABLED is true', () => {
  let harness: Harness
  let validSceneJob: DeploymentToSqs
  let validLodJob: DeploymentToSqs

  beforeEach(async () => {
    harness = await buildHarness({ triageEnabled: true })
    validSceneJob = buildValidSceneJob()
    validLodJob = buildValidLodJob()
  })

  afterEach(() => {
    jest.clearAllMocks()
  })

  describe('and the job has a lods array', () => {
    beforeEach(async () => {
      await harness.orchestrator.processIncomingJob(validLodJob, false)
    })

    it('should republish the job to the Conversion queue without calling executeTriagePass', () => {
      expect(mockedExecuteTriagePass).not.toHaveBeenCalled()
      expect(harness.conversionPublish).toHaveBeenCalledWith(
        expect.objectContaining({ entity: expect.objectContaining({ entityId: 'bafy-lod' }) }),
        false
      )
    })

    it('should not publish a finished event yet (conversion loop will, after the conversion)', () => {
      expect(harness.publisher.publishMessage).not.toHaveBeenCalled()
    })
  })

  describe('and executeTriagePass returns kind: completed (cache hit / already-converted)', () => {
    beforeEach(async () => {
      mockedExecuteTriagePass.mockResolvedValueOnce({ kind: 'completed', exitCode: 0 })
      await harness.orchestrator.processIncomingJob(validSceneJob, false)
    })

    it('should publish a finished event carrying the triage exit code', () => {
      expect(harness.publisher.publishMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          metadata: expect.objectContaining({ entityId: 'bafy-scene', statusCode: 0 })
        })
      )
    })

    it('should not republish the job to the Conversion queue', () => {
      expect(harness.conversionPublish).not.toHaveBeenCalled()
    })
  })

  describe('and executeTriagePass returns kind: failed (probe error, sentinel uploaded)', () => {
    beforeEach(async () => {
      mockedExecuteTriagePass.mockResolvedValueOnce({ kind: 'failed', exitCode: 5 })
      await harness.orchestrator.processIncomingJob(validSceneJob, false)
    })

    it('should publish a finished event carrying the failure exit code so downstream consumers see the failure', () => {
      expect(harness.publisher.publishMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          metadata: expect.objectContaining({ entityId: 'bafy-scene', statusCode: 5 })
        })
      )
    })

    it('should not republish the job to the Conversion queue (would just fail again the same way)', () => {
      expect(harness.conversionPublish).not.toHaveBeenCalled()
    })
  })

  describe('and executeTriagePass returns kind: needs-unity', () => {
    beforeEach(async () => {
      mockedExecuteTriagePass.mockResolvedValueOnce({ kind: 'needs-unity' })
      await harness.orchestrator.processIncomingJob(validSceneJob, false)
    })

    it('should republish the original job to the Conversion queue with prioritize=false', () => {
      expect(harness.conversionPublish).toHaveBeenCalledWith(
        expect.objectContaining({ entity: expect.objectContaining({ entityId: 'bafy-scene' }) }),
        false
      )
    })

    it('should not publish a finished event (conversion loop publishes after conversion completes)', () => {
      expect(harness.publisher.publishMessage).not.toHaveBeenCalled()
    })
  })

  describe('and the message arrived from the priority queue', () => {
    beforeEach(async () => {
      mockedExecuteTriagePass.mockResolvedValueOnce({ kind: 'needs-unity' })
      await harness.orchestrator.processIncomingJob(validSceneJob, true)
    })

    it('should preserve priority on the Conversion-queue republish (prioritize=true)', () => {
      expect(harness.conversionPublish).toHaveBeenCalledWith(expect.anything(), true)
    })
  })

  describe('and conversionTaskQueue.publish throws during republish', () => {
    let thrown: unknown

    beforeEach(async () => {
      mockedExecuteTriagePass.mockResolvedValueOnce({ kind: 'needs-unity' })
      harness.conversionPublish.mockRejectedValueOnce(new Error('SQS access denied'))
      mockedExecuteConversion.mockResolvedValueOnce(0)
      try {
        await harness.orchestrator.processIncomingJob(validSceneJob, false)
      } catch (err) {
        thrown = err
      }
    })

    it('should not throw — the republish failure is caught and handled inline', () => {
      expect(thrown).toBeUndefined()
    })

    it('should fall back to running the full conversion inline so no work is lost', () => {
      expect(mockedExecuteConversion).toHaveBeenCalledWith(
        expect.anything(),
        'bafy-scene',
        'https://peer.decentraland.org/content',
        undefined,
        undefined,
        undefined,
        'v48'
      )
    })

    it('should publish a finished event carrying the inline-conversion exit code', () => {
      expect(harness.publisher.publishMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          metadata: expect.objectContaining({ entityId: 'bafy-scene', statusCode: 0 })
        })
      )
    })
  })

  describe('and a LOD republish to the Conversion queue fails', () => {
    beforeEach(async () => {
      harness.conversionPublish.mockRejectedValueOnce(new Error('SQS access denied'))
      mockedExecuteLODConversion.mockResolvedValueOnce(0)
      await harness.orchestrator.processIncomingJob(validLodJob, false)
    })

    it('should fall back to running the LOD conversion inline', () => {
      expect(mockedExecuteLODConversion).toHaveBeenCalledWith(
        expect.anything(),
        'bafy-lod',
        ['lod-1.glb', 'lod-2.glb'],
        'v48'
      )
    })

    it('should publish a finished event for the inline LOD conversion', () => {
      expect(harness.publisher.publishMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          metadata: expect.objectContaining({ entityId: 'bafy-lod', isLods: true, statusCode: 0 })
        })
      )
    })
  })

  describe('and the job is missing entity.entityId', () => {
    beforeEach(async () => {
      await harness.orchestrator.processIncomingJob({ type: 'world_undeployment' } as any, false)
    })

    it('should skip the job before any dispatch (validation guard fires first)', () => {
      expect(mockedExecuteTriagePass).not.toHaveBeenCalled()
      expect(harness.conversionPublish).not.toHaveBeenCalled()
      expect(harness.publisher.publishMessage).not.toHaveBeenCalled()
    })
  })
})

describe('when processConversionJob is called', () => {
  let harness: Harness
  let validSceneJob: DeploymentToSqs
  let validLodJob: DeploymentToSqs

  beforeEach(async () => {
    // The conversion loop ignores FAST_PATH_TRIAGE_ENABLED entirely — it always
    // drains the Conversion queue. Build with the flag off to confirm the
    // independence and to keep a single harness configuration here.
    harness = await buildHarness({ triageEnabled: false })
    validSceneJob = buildValidSceneJob()
    validLodJob = buildValidLodJob()
  })

  afterEach(() => {
    jest.clearAllMocks()
  })

  describe('and the job is missing entity.entityId', () => {
    beforeEach(async () => {
      await harness.orchestrator.processConversionJob({ type: 'world_undeployment' } as any)
    })

    it('should skip the job and not call executeConversion', () => {
      expect(mockedExecuteConversion).not.toHaveBeenCalled()
      expect(harness.publisher.publishMessage).not.toHaveBeenCalled()
    })
  })

  describe('and the job is a scene', () => {
    beforeEach(async () => {
      mockedExecuteConversion.mockResolvedValueOnce(0)
      await harness.orchestrator.processConversionJob(validSceneJob)
    })

    it('should call executeConversion with the entity', () => {
      expect(mockedExecuteConversion).toHaveBeenCalledWith(
        expect.anything(),
        'bafy-scene',
        'https://peer.decentraland.org/content',
        undefined,
        undefined,
        undefined,
        'v48'
      )
    })

    it('should publish a finished event with the conversion exit code', () => {
      expect(harness.publisher.publishMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          metadata: expect.objectContaining({ entityId: 'bafy-scene', statusCode: 0 })
        })
      )
    })
  })

  describe('and the job has a lods array', () => {
    beforeEach(async () => {
      mockedExecuteLODConversion.mockResolvedValueOnce(0)
      await harness.orchestrator.processConversionJob(validLodJob)
    })

    it('should call executeLODConversion (not executeConversion)', () => {
      expect(mockedExecuteLODConversion).toHaveBeenCalledWith(
        expect.anything(),
        'bafy-lod',
        ['lod-1.glb', 'lod-2.glb'],
        'v48'
      )
      expect(mockedExecuteConversion).not.toHaveBeenCalled()
    })
  })

  describe('and the job has doISS=true', () => {
    beforeEach(async () => {
      mockedExecuteConversion.mockResolvedValueOnce(0)
      await harness.orchestrator.processConversionJob({ ...validSceneJob, doISS: true } as any)
    })

    it('should pass v2004 as the version', () => {
      const callArgs = mockedExecuteConversion.mock.calls[0]
      expect(callArgs[6]).toBe('v2004')
    })
  })
})
