// Unit coverage for the catalyst allowlist guard (issue #306). The
// content-server URL rides in the attacker-influenced SQS payload, so it is
// validated against a strict HTTPS + exact-host allowlist before the worker
// fetches from it. The allowlist is sourced entirely from the ALLOWED_CONTENT_SERVER_HOSTS
// env var — there is no built-in default list. The LOD-oriented
// isSafeOutboundUrl heuristic is covered alongside it.

import { isAllowedContentServerUrl, isSafeOutboundUrl, parseAllowedContentServerHosts } from '../../src/utils'

describe('when parsing the ALLOWED_CONTENT_SERVER_HOSTS env var', () => {
  describe('and the value is undefined', () => {
    let result: Set<string>

    beforeEach(() => {
      result = parseAllowedContentServerHosts(undefined)
    })

    it('should produce an empty set (no built-in default)', () => {
      expect(result.size).toBe(0)
    })
  })

  describe('and the value is an empty string', () => {
    let result: Set<string>

    beforeEach(() => {
      result = parseAllowedContentServerHosts('')
    })

    it('should produce an empty set', () => {
      expect(result.size).toBe(0)
    })
  })

  describe('and the value is a comma-separated list of bare hostnames', () => {
    let result: Set<string>

    beforeEach(() => {
      result = parseAllowedContentServerHosts('peer.example.org, peer-2.example.org')
    })

    it('should trim each entry and produce the configured hosts', () => {
      expect(result).toEqual(new Set(['peer.example.org', 'peer-2.example.org']))
    })
  })

  describe('and an entry is a full URL rather than a bare host', () => {
    let result: Set<string>

    beforeEach(() => {
      result = parseAllowedContentServerHosts('https://peer.example.org/content,peer-2.example.org')
    })

    it('should normalize the URL entry down to its hostname', () => {
      expect(result).toEqual(new Set(['peer.example.org', 'peer-2.example.org']))
    })
  })

  describe('and the value is uppercased', () => {
    let result: Set<string>

    beforeEach(() => {
      result = parseAllowedContentServerHosts('PEER.EXAMPLE.ORG')
    })

    it('should lowercase the host so matching is case-insensitive', () => {
      expect(result).toEqual(new Set(['peer.example.org']))
    })
  })

  describe('and the value contains only separators and whitespace', () => {
    let result: Set<string>

    beforeEach(() => {
      result = parseAllowedContentServerHosts('  , ,')
    })

    it('should produce an empty set', () => {
      expect(result.size).toBe(0)
    })
  })
})

describe('when validating a content-server URL against the catalyst allowlist', () => {
  let allowed: Set<string>

  beforeEach(() => {
    allowed = parseAllowedContentServerHosts('peer.decentraland.org, worlds-content-server.decentraland.org')
  })

  describe('and the URL is an HTTPS allowlisted catalyst', () => {
    it('should accept it', () => {
      expect(isAllowedContentServerUrl('https://peer.decentraland.org/content', allowed)).toBe(true)
    })
  })

  describe('and the URL is an HTTPS allowlisted worlds content server', () => {
    it('should accept it', () => {
      expect(isAllowedContentServerUrl('https://worlds-content-server.decentraland.org/content', allowed)).toBe(true)
    })
  })

  describe('and the host is not on the allowlist', () => {
    it('should reject it', () => {
      expect(isAllowedContentServerUrl('https://evil.example.com/content', allowed)).toBe(false)
    })
  })

  describe('and the URL points at the cloud metadata IP', () => {
    it('should reject it (no IP literal is on the allowlist)', () => {
      expect(isAllowedContentServerUrl('https://169.254.169.254/latest/meta-data/', allowed)).toBe(false)
    })
  })

  describe('and an allowlisted host is requested over plain HTTP', () => {
    it('should reject it because catalysts must be HTTPS', () => {
      expect(isAllowedContentServerUrl('http://peer.decentraland.org/content', allowed)).toBe(false)
    })
  })

  describe('and the value is not a parseable URL', () => {
    it('should reject it', () => {
      expect(isAllowedContentServerUrl('not a url', allowed)).toBe(false)
    })
  })

  describe('and the allowlist is empty', () => {
    it('should reject every URL', () => {
      expect(isAllowedContentServerUrl('https://peer.decentraland.org/content', new Set())).toBe(false)
    })
  })
})

describe('when validating a LOD source URL with isSafeOutboundUrl', () => {
  describe('and the URL is a named HTTPS host', () => {
    it('should accept it', () => {
      expect(isSafeOutboundUrl('https://lod-cdn.example.com/lod-1.glb')).toBe(true)
    })
  })

  describe('and the URL is the cloud metadata IP literal', () => {
    it('should reject it', () => {
      expect(isSafeOutboundUrl('http://169.254.169.254/latest/meta-data/')).toBe(false)
    })
  })

  describe('and the URL uses plain HTTP', () => {
    it('should reject it (no protocol downgrade)', () => {
      expect(isSafeOutboundUrl('http://lod-cdn.example.com/lod-1.glb')).toBe(false)
    })
  })

  describe('and the URL targets an internal hostname', () => {
    it('should reject a .internal host', () => {
      expect(isSafeOutboundUrl('https://metadata.internal/lod.glb')).toBe(false)
    })

    it('should reject a .onion host', () => {
      expect(isSafeOutboundUrl('https://abcd1234.onion/lod.glb')).toBe(false)
    })
  })
})
