// Unit coverage for the catalyst adapter. Verifies CID validation, URL
// construction, the AbortController-based timeout, the entity-id backfill
// for /contents/-format responses, and that getEntities POSTs the pointer
// list with the expected headers.

import type { IFetchComponent } from '@well-known-components/interfaces'
import { createCatalystComponent, ICatalystComponent } from '../../src/adapters/catalyst'

const originalNativeFetch = globalThis.fetch

type FetchMock = jest.Mock<Promise<any>, [any, any?]>

function makeResponse(opts: { ok?: boolean; status?: number; body: unknown }): any {
  return {
    ok: opts.ok ?? true,
    status: opts.status ?? 200,
    text: jest.fn(async () => (typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body)))
  }
}

describe('when getActiveEntity is called', () => {
  let nativeFetchMock: FetchMock
  let fetchComponent: IFetchComponent
  let catalyst: ICatalystComponent

  beforeEach(async () => {
    nativeFetchMock = jest.fn()
    globalThis.fetch = nativeFetchMock as any
    fetchComponent = { fetch: jest.fn() } as any
    catalyst = await createCatalystComponent({ fetch: fetchComponent })
  })

  afterEach(() => {
    globalThis.fetch = originalNativeFetch
    jest.clearAllMocks()
  })

  describe('and the entity id contains characters outside [a-zA-Z0-9]', () => {
    it('should throw an "Invalid entity ID format" error before any network call', async () => {
      await expect(catalyst.getActiveEntity('bad/id', 'https://catalyst.example/content')).rejects.toThrow(
        /Invalid entity ID format/
      )
      expect(nativeFetchMock).not.toHaveBeenCalled()
    })
  })

  describe('and the entity id is well-formed', () => {
    describe('and the contentServer URL ends with a trailing slash', () => {
      let result: any

      beforeEach(async () => {
        nativeFetchMock.mockResolvedValueOnce(makeResponse({ body: { type: 'scene', content: [] } }))
        result = await catalyst.getActiveEntity('bafy123', 'https://catalyst.example/content/')
      })

      it('should construct the URL without doubling the slash', () => {
        expect(nativeFetchMock).toHaveBeenCalledWith(
          'https://catalyst.example/content/contents/bafy123',
          expect.any(Object)
        )
      })

      it('should backfill the id field on the parsed entity (catalyst /contents/ omits it)', () => {
        expect(result.id).toBe('bafy123')
      })
    })

    describe('and the contentServer URL does not end with a trailing slash', () => {
      beforeEach(async () => {
        nativeFetchMock.mockResolvedValueOnce(makeResponse({ body: { type: 'scene', content: [] } }))
        await catalyst.getActiveEntity('bafy123', 'https://catalyst.example/content')
      })

      it('should append the missing slash before /contents/', () => {
        expect(nativeFetchMock).toHaveBeenCalledWith(
          'https://catalyst.example/content/contents/bafy123',
          expect.any(Object)
        )
      })
    })

    describe('and the catalyst returns an entity that already carries an id field', () => {
      let result: any

      beforeEach(async () => {
        nativeFetchMock.mockResolvedValueOnce(makeResponse({ body: { id: 'existing-id', type: 'scene', content: [] } }))
        result = await catalyst.getActiveEntity('bafy123', 'https://catalyst.example/content')
      })

      it('should leave the existing id field untouched rather than overwriting with the requested id', () => {
        // Defends against a future "always set entity.id = id" simplification
        // that would erase a catalyst-supplied id (which may be the canonical
        // form even when the request used a pointer alias).
        expect(result.id).toBe('existing-id')
      })
    })

    describe('and the catalyst returns a non-2xx response', () => {
      beforeEach(() => {
        nativeFetchMock.mockResolvedValueOnce(
          makeResponse({ ok: false, status: 502, body: 'upstream timeout' })
        )
      })

      it('should throw an error containing the response body for triage', async () => {
        await expect(catalyst.getActiveEntity('bafy123', 'https://catalyst.example/content')).rejects.toThrow(
          /upstream timeout/
        )
      })
    })

    describe('and a timeoutMs is supplied and the catalyst hangs', () => {
      let abortObserved: boolean

      beforeEach(() => {
        abortObserved = false
        // Hang fetch — only resolves on abort. AbortController.abort()
        // dispatches an 'abort' event on the signal; the implementation
        // wires that to AbortError. We assert both the error AND that the
        // signal was actually attached to the request init.
        nativeFetchMock.mockImplementation((_url: string, init: RequestInit) => {
          return new Promise((_resolve, reject) => {
            init.signal!.addEventListener('abort', () => {
              abortObserved = true
              const err: any = new Error('aborted by AbortController')
              err.name = 'AbortError'
              reject(err)
            })
          })
        })
      })

      it('should pass an AbortSignal in the fetch init', async () => {
        await expect(
          catalyst.getActiveEntity('bafy123', 'https://catalyst.example/content', 30)
        ).rejects.toThrow(/aborted/)
        const init = nativeFetchMock.mock.calls[0][1]
        expect(init.signal).toBeDefined()
      })

      it('should reject with the AbortError once the deadline elapses', async () => {
        await expect(
          catalyst.getActiveEntity('bafy123', 'https://catalyst.example/content', 30)
        ).rejects.toThrow(/aborted/)
        expect(abortObserved).toBe(true)
      })
    })

    describe('and no timeoutMs is supplied', () => {
      beforeEach(async () => {
        nativeFetchMock.mockResolvedValueOnce(makeResponse({ body: { type: 'scene' } }))
        await catalyst.getActiveEntity('bafy123', 'https://catalyst.example/content')
      })

      it('should not pass a signal in the fetch init (no abort, indefinite wait)', () => {
        const init = nativeFetchMock.mock.calls[0][1]
        // The implementation passes `signal: undefined` when no timeout is
        // configured (falsy controller), which fetch treats the same as
        // omitting it entirely.
        expect(init.signal).toBeUndefined()
      })
    })
  })
})

describe('when getEntities is called', () => {
  let fetchMock: jest.Mock
  let catalyst: ICatalystComponent

  beforeEach(async () => {
    fetchMock = jest.fn()
    catalyst = await createCatalystComponent({ fetch: { fetch: fetchMock } as any })
  })

  afterEach(() => {
    jest.clearAllMocks()
  })

  describe('and the catalyst returns 200 with a list of entities', () => {
    let result: any[]

    beforeEach(async () => {
      fetchMock.mockResolvedValueOnce(makeResponse({ body: [{ id: 'e1' }, { id: 'e2' }] }))
      result = await catalyst.getEntities(['0,0', '1,0'], 'https://catalyst.example/content')
    })

    it('should POST to /entities/active', () => {
      expect(fetchMock).toHaveBeenCalledWith(
        'https://catalyst.example/content/entities/active',
        expect.objectContaining({ method: 'post' })
      )
    })

    it('should serialize the pointers into the request body as { pointers: [...] }', () => {
      const init = fetchMock.mock.calls[0][1]
      expect(JSON.parse(init.body)).toEqual({ pointers: ['0,0', '1,0'] })
    })

    it('should set the application/json content-type header', () => {
      const init = fetchMock.mock.calls[0][1]
      expect(init.headers).toEqual({ 'content-type': 'application/json' })
    })

    it('should return the parsed entity list', () => {
      expect(result).toEqual([{ id: 'e1' }, { id: 'e2' }])
    })
  })

  describe('and the catalyst returns a non-2xx response', () => {
    beforeEach(() => {
      fetchMock.mockResolvedValueOnce(makeResponse({ ok: false, status: 500, body: 'pointer table overloaded' }))
    })

    it('should throw with the response body in the error message', async () => {
      await expect(
        catalyst.getEntities(['0,0'], 'https://catalyst.example/content')
      ).rejects.toThrow(/pointer table overloaded/)
    })
  })
})
