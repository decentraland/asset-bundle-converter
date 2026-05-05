import { createSqsAdapter } from '../../src/adapters/task-queue'

jest.mock('aws-sdk', () => {
  const sqsMock = {
    receiveMessage: jest.fn(),
    deleteMessage: jest.fn(),
    changeMessageVisibility: jest.fn(),
    sendMessage: jest.fn()
  }
  return {
    SQS: jest.fn().mockImplementation(() => sqsMock),
    __sqsMock: sqsMock
  }
})

const sqsMock = (require('aws-sdk') as any).__sqsMock as {
  receiveMessage: jest.Mock
  deleteMessage: jest.Mock
  changeMessageVisibility: jest.Mock
  sendMessage: jest.Mock
}

function makeComponents() {
  return {
    logs: {
      getLogger: () => ({
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
        debug: jest.fn(),
        log: jest.fn()
      })
    },
    metrics: {
      increment: jest.fn(),
      decrement: jest.fn(),
      observe: jest.fn(),
      startTimer: jest.fn().mockReturnValue({ end: jest.fn() }),
      reset: jest.fn(),
      resetAll: jest.fn(),
      getValue: jest.fn(),
      register: jest.fn()
    }
  } as any
}

function mockOneMessage(receiptHandle = 'rh-1', messageId = 'msg-1') {
  sqsMock.receiveMessage.mockReturnValueOnce({
    promise: () =>
      Promise.resolve({
        Messages: [
          {
            MessageId: messageId,
            ReceiptHandle: receiptHandle,
            Body: JSON.stringify({ Message: JSON.stringify({ entity: { entityId: 'e1' } }) })
          }
        ]
      })
  })
}

describe('createSqsAdapter releaseInFlight', () => {
  beforeEach(() => {
    sqsMock.receiveMessage.mockReset()
    sqsMock.deleteMessage.mockReset()
    sqsMock.changeMessageVisibility.mockReset()
    sqsMock.sendMessage.mockReset()
    sqsMock.deleteMessage.mockReturnValue({ promise: () => Promise.resolve({}) })
    sqsMock.changeMessageVisibility.mockReturnValue({ promise: () => Promise.resolve({}) })
  })

  it('releases in-flight message via changeMessageVisibility(0) and skips delete', async () => {
    mockOneMessage('rh-1', 'msg-1')
    const adapter = createSqsAdapter<any>(makeComponents(), { queueUrl: 'q-url' })

    let resolveStarted!: () => void
    const started = new Promise<void>((r) => (resolveStarted = r))
    let resolveTask!: (v: number) => void
    const taskPromise = new Promise<number>((r) => (resolveTask = r))

    const consume = adapter.consumeAndProcessJob(async () => {
      resolveStarted()
      return taskPromise
    })

    await started
    await adapter.releaseInFlight()

    expect(sqsMock.changeMessageVisibility).toHaveBeenCalledTimes(1)
    expect(sqsMock.changeMessageVisibility).toHaveBeenCalledWith({
      QueueUrl: 'q-url',
      ReceiptHandle: 'rh-1',
      VisibilityTimeout: 0
    })

    resolveTask(0)
    await consume

    expect(sqsMock.deleteMessage).not.toHaveBeenCalled()
  })

  it('successful task path deletes the message and never releases', async () => {
    mockOneMessage('rh-2', 'msg-2')
    const adapter = createSqsAdapter<any>(makeComponents(), { queueUrl: 'q-url' })

    await adapter.consumeAndProcessJob(async () => 0)

    expect(sqsMock.deleteMessage).toHaveBeenCalledTimes(1)
    expect(sqsMock.deleteMessage).toHaveBeenCalledWith({ QueueUrl: 'q-url', ReceiptHandle: 'rh-2' })
    expect(sqsMock.changeMessageVisibility).not.toHaveBeenCalled()

    // No in-flight after success — releaseInFlight is a no-op.
    await adapter.releaseInFlight()
    expect(sqsMock.changeMessageVisibility).not.toHaveBeenCalled()
  })

  it('releaseInFlight is a no-op when nothing is in flight', async () => {
    const adapter = createSqsAdapter<any>(makeComponents(), { queueUrl: 'q-url' })

    await adapter.releaseInFlight()

    expect(sqsMock.changeMessageVisibility).not.toHaveBeenCalled()
    expect(sqsMock.deleteMessage).not.toHaveBeenCalled()
  })

  it('only releases once when called multiple times for the same message', async () => {
    mockOneMessage('rh-3', 'msg-3')
    const adapter = createSqsAdapter<any>(makeComponents(), { queueUrl: 'q-url' })

    let resolveStarted!: () => void
    const started = new Promise<void>((r) => (resolveStarted = r))
    let resolveTask!: (v: number) => void
    const taskPromise = new Promise<number>((r) => (resolveTask = r))

    const consume = adapter.consumeAndProcessJob(async () => {
      resolveStarted()
      return taskPromise
    })

    await started
    await Promise.all([adapter.releaseInFlight(), adapter.releaseInFlight(), adapter.releaseInFlight()])

    expect(sqsMock.changeMessageVisibility).toHaveBeenCalledTimes(1)

    resolveTask(0)
    await consume
  })

  it('release survives a changeMessageVisibility error without throwing', async () => {
    mockOneMessage('rh-4', 'msg-4')
    sqsMock.changeMessageVisibility.mockReturnValueOnce({
      promise: () => Promise.reject(new Error('aws boom'))
    })
    const adapter = createSqsAdapter<any>(makeComponents(), { queueUrl: 'q-url' })

    let resolveStarted!: () => void
    const started = new Promise<void>((r) => (resolveStarted = r))
    let resolveTask!: (v: number) => void
    const taskPromise = new Promise<number>((r) => (resolveTask = r))

    const consume = adapter.consumeAndProcessJob(async () => {
      resolveStarted()
      return taskPromise
    })

    await started
    await expect(adapter.releaseInFlight()).resolves.toBeUndefined()

    resolveTask(0)
    await consume
  })
})
