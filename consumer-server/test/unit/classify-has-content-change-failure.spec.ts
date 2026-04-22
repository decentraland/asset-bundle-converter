import {
  classifyHasContentChangeFailure,
  HasContentChangeFailureReason
} from '../../src/logic/classify-has-content-change-failure'

describe('classifyHasContentChangeFailure', () => {
  let result: HasContentChangeFailureReason

  describe('when the error is a timeout', () => {
    describe("and the message is 'Request timeout after 10000ms'", () => {
      beforeEach(() => {
        result = classifyHasContentChangeFailure(new Error('Request timeout after 10000ms'))
      })

      it('should classify the failure as timeout', () => {
        expect(result).toBe('timeout')
      })
    })

    describe("and the message is a node-level ETIMEDOUT", () => {
      beforeEach(() => {
        result = classifyHasContentChangeFailure(new Error('connect ETIMEDOUT 1.2.3.4:443'))
      })

      it('should classify the failure as timeout', () => {
        expect(result).toBe('timeout')
      })
    })

    describe("and the message embeds a 5xx-looking substring like '500ms'", () => {
      // Regression: a naive regex check would mis-classify this as server_error.
      // Timeout detection must run before the 5xx regex.
      beforeEach(() => {
        result = classifyHasContentChangeFailure(new Error('timeout after 500ms'))
      })

      it('should classify the failure as timeout, not server_error', () => {
        expect(result).toBe('timeout')
      })
    })
  })

  describe('when the error is a network-level failure', () => {
    describe('and the message is an ECONNREFUSED', () => {
      beforeEach(() => {
        result = classifyHasContentChangeFailure(new Error('connect ECONNREFUSED 127.0.0.1:443'))
      })

      it('should classify the failure as network', () => {
        expect(result).toBe('network')
      })
    })

    describe('and the message is an ENOTFOUND from DNS resolution', () => {
      beforeEach(() => {
        result = classifyHasContentChangeFailure(
          new Error('getaddrinfo ENOTFOUND worlds-content-server.decentraland.org')
        )
      })

      it('should classify the failure as network', () => {
        expect(result).toBe('network')
      })
    })

    describe("and the message is a generic 'fetch failed'", () => {
      beforeEach(() => {
        result = classifyHasContentChangeFailure(new Error('fetch failed'))
      })

      it('should classify the failure as network', () => {
        expect(result).toBe('network')
      })
    })
  })

  describe('when the upstream returns a 400-class error', () => {
    describe("and the message is the worlds-content-server 'Bad request' body from the 2026-04-19 incident", () => {
      beforeEach(() => {
        result = classifyHasContentChangeFailure(
          new Error('Error fetching pointer changes: {"error":"Bad request","message":"Request body is not valid"}')
        )
      })

      it('should classify the failure as bad_request', () => {
        expect(result).toBe('bad_request')
      })
    })

    describe("and the message contains 'Invalid request'", () => {
      beforeEach(() => {
        result = classifyHasContentChangeFailure(new Error('Invalid request: missing field'))
      })

      it('should classify the failure as bad_request', () => {
        expect(result).toBe('bad_request')
      })
    })

    describe('and the message contains a bare 400 status token', () => {
      beforeEach(() => {
        result = classifyHasContentChangeFailure(new Error('HTTP 400 returned'))
      })

      it('should classify the failure as bad_request', () => {
        expect(result).toBe('bad_request')
      })
    })
  })

  describe('when the upstream returns a 500-class error', () => {
    describe("and the message is 'status: 502'", () => {
      beforeEach(() => {
        result = classifyHasContentChangeFailure(new Error('Upstream responded with status: 502'))
      })

      it('should classify the failure as server_error', () => {
        expect(result).toBe('server_error')
      })
    })

    describe("and the message is 'status 500 Internal Server Error' (space-separated)", () => {
      beforeEach(() => {
        result = classifyHasContentChangeFailure(new Error('Upstream responded with status 500 Internal Server Error'))
      })

      it('should classify the failure as server_error', () => {
        expect(result).toBe('server_error')
      })
    })

    describe("and the message contains a bare '503 ' substring", () => {
      beforeEach(() => {
        result = classifyHasContentChangeFailure(new Error('Got 503 from worlds-content-server'))
      })

      it('should classify the failure as server_error', () => {
        expect(result).toBe('server_error')
      })
    })
  })

  describe('when the error does not match any known pattern', () => {
    describe('and the message is unrelated text', () => {
      beforeEach(() => {
        result = classifyHasContentChangeFailure(new Error('something exploded in JSON parsing'))
      })

      it('should classify the failure as other', () => {
        expect(result).toBe('other')
      })
    })

    describe('and the Error message is empty', () => {
      beforeEach(() => {
        result = classifyHasContentChangeFailure(new Error(''))
      })

      it('should classify the failure as other', () => {
        expect(result).toBe('other')
      })
    })
  })

  describe('when the thrown value is not an Error instance', () => {
    describe('and the value is a plain string with no known signal', () => {
      beforeEach(() => {
        result = classifyHasContentChangeFailure('whatever')
      })

      it('should classify the failure as other', () => {
        expect(result).toBe('other')
      })
    })

    describe('and the value is undefined', () => {
      beforeEach(() => {
        result = classifyHasContentChangeFailure(undefined)
      })

      it('should classify the failure as other', () => {
        expect(result).toBe('other')
      })
    })

    describe('and the value is null', () => {
      beforeEach(() => {
        result = classifyHasContentChangeFailure(null)
      })

      it('should classify the failure as other', () => {
        expect(result).toBe('other')
      })
    })

    describe("and the value is a plain string containing 'timeout'", () => {
      beforeEach(() => {
        result = classifyHasContentChangeFailure('fetch timeout')
      })

      it('should classify the failure as timeout', () => {
        expect(result).toBe('timeout')
      })
    })
  })

  describe('when the message contains multiple signals', () => {
    describe('and it contains both a timeout phrase and a 5xx-looking token', () => {
      beforeEach(() => {
        result = classifyHasContentChangeFailure(new Error('timeout after 500ms waiting for worlds-content-server'))
      })

      it('should prefer timeout over server_error', () => {
        expect(result).toBe('timeout')
      })
    })

    describe('and it contains both a network phrase and a 400-status token', () => {
      beforeEach(() => {
        result = classifyHasContentChangeFailure(new Error('fetch failed: 400 upstream'))
      })

      it('should prefer network over bad_request', () => {
        expect(result).toBe('network')
      })
    })
  })
})
