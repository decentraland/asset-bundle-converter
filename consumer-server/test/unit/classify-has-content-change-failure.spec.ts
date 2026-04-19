import { classifyHasContentChangeFailure } from '../../src/logic/classify-has-content-change-failure'

describe('classifyHasContentChangeFailure', () => {
  describe('when the error is a timeout', () => {
    it('should classify "timeout after 10000ms" as timeout', () => {
      const err = new Error('Request timeout after 10000ms')
      expect(classifyHasContentChangeFailure(err)).toBe('timeout')
    })

    it('should classify an ETIMEDOUT error as timeout', () => {
      const err = new Error('connect ETIMEDOUT 1.2.3.4:443')
      expect(classifyHasContentChangeFailure(err)).toBe('timeout')
    })

    it('should classify a timeout whose message contains a 5xx-looking substring as timeout', () => {
      // A naïve regex check would mis-classify this as server_error because
      // "500ms" contains "500". Timeout detection must run first.
      const err = new Error('timeout after 500ms')
      expect(classifyHasContentChangeFailure(err)).toBe('timeout')
    })
  })

  describe('when the error is a network-level failure', () => {
    it('should classify an ECONNREFUSED error as network', () => {
      const err = new Error('connect ECONNREFUSED 127.0.0.1:443')
      expect(classifyHasContentChangeFailure(err)).toBe('network')
    })

    it('should classify an ENOTFOUND error as network', () => {
      const err = new Error('getaddrinfo ENOTFOUND worlds-content-server.decentraland.org')
      expect(classifyHasContentChangeFailure(err)).toBe('network')
    })

    it('should classify a generic "fetch failed" error as network', () => {
      const err = new Error('fetch failed')
      expect(classifyHasContentChangeFailure(err)).toBe('network')
    })
  })

  describe('when the upstream returns a 400-class error', () => {
    it('should classify a "Bad request" message as bad_request', () => {
      // This is the exact message worlds-content-server returned during the
      // 2026-04-19 incident.
      const err = new Error(
        'Error fetching pointer changes: {"error":"Bad request","message":"Request body is not valid"}'
      )
      expect(classifyHasContentChangeFailure(err)).toBe('bad_request')
    })

    it('should classify an "Invalid request" message as bad_request', () => {
      const err = new Error('Invalid request: missing field')
      expect(classifyHasContentChangeFailure(err)).toBe('bad_request')
    })

    it('should classify a message containing a bare 400 status token as bad_request', () => {
      const err = new Error('HTTP 400 returned')
      expect(classifyHasContentChangeFailure(err)).toBe('bad_request')
    })
  })

  describe('when the upstream returns a 500-class error', () => {
    it('should classify a "status: 502" message as server_error', () => {
      const err = new Error('Upstream responded with status: 502')
      expect(classifyHasContentChangeFailure(err)).toBe('server_error')
    })

    it('should classify a "status 500" (space-separated) message as server_error', () => {
      const err = new Error('Upstream responded with status 500 Internal Server Error')
      expect(classifyHasContentChangeFailure(err)).toBe('server_error')
    })

    it('should classify a bare "503 " substring as server_error', () => {
      const err = new Error('Got 503 from worlds-content-server')
      expect(classifyHasContentChangeFailure(err)).toBe('server_error')
    })
  })

  describe('when the error does not match any known pattern', () => {
    it('should classify an unrelated error as other', () => {
      const err = new Error('something exploded in JSON parsing')
      expect(classifyHasContentChangeFailure(err)).toBe('other')
    })

    it('should classify an empty error message as other', () => {
      const err = new Error('')
      expect(classifyHasContentChangeFailure(err)).toBe('other')
    })
  })

  describe('when the thrown value is not an Error instance', () => {
    it('should classify a plain string as other', () => {
      expect(classifyHasContentChangeFailure('whatever')).toBe('other')
    })

    it('should classify undefined as other', () => {
      expect(classifyHasContentChangeFailure(undefined)).toBe('other')
    })

    it('should classify null as other', () => {
      expect(classifyHasContentChangeFailure(null)).toBe('other')
    })

    it('should classify a string containing "timeout" as timeout', () => {
      expect(classifyHasContentChangeFailure('fetch timeout')).toBe('timeout')
    })
  })

  describe('when the message contains multiple signals', () => {
    it('should prefer timeout over 5xx when both appear in the message', () => {
      // The ordering invariant we care about — timeout check runs first.
      const err = new Error('timeout after 500ms waiting for worlds-content-server')
      expect(classifyHasContentChangeFailure(err)).toBe('timeout')
    })

    it('should prefer network over bad_request when both appear in the message', () => {
      // Network / DNS errors are the more fundamental failure.
      const err = new Error('fetch failed: 400 upstream')
      expect(classifyHasContentChangeFailure(err)).toBe('network')
    })
  })
})
