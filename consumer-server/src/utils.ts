import { isIP } from 'net'

export function getUnityBuildTarget(target: string): string | undefined {
  switch (target) {
    case 'webgl':
      return 'WebGL'
    case 'windows':
      return 'StandaloneWindows64'
    case 'mac':
      return 'StandaloneOSX'
    default:
      return undefined
  }
}

/**
 * Normalize a catalyst URL into the `/contents/` endpoint used to fetch
 * asset bytes by content hash: `{normalized}{hash}` is the GET URL.
 *
 * Previously duplicated in three places (conversion-task.ts for scene-source
 * uploads, run-conversion.ts for Unity's `-baseUrl`, asset-reuse.ts for glb
 * parsing). If they drifted (e.g. a new special-cased URL added to one but
 * not the others), server and Unity would fetch from different endpoints
 * for the same scene — silent divergence. One canonical implementation
 * keeps the endpoint rewrite lockstep across callers.
 *
 * Special cases:
 * - Trailing `/contents/` → returned unchanged.
 * - sdk-team-cdn's IPFS endpoint doesn't use the `/contents/` suffix.
 * - Missing trailing slash → added before the `/contents/` append.
 */
export function normalizeContentsBaseUrl(url: string): string {
  let out = url
  if (!out.endsWith('/')) out += '/'
  if (out !== 'https://sdk-team-cdn.decentraland.org/ipfs/' && !out.endsWith('contents/')) {
    out += 'contents/'
  }
  return out
}

// Loopback / internal-only DNS suffixes a public LOD host should never use.
// IP-literal hosts (incl. the cloud-metadata IP) are blocked separately via isIP.
const INTERNAL_HOST_SUFFIXES = ['.localhost', '.local', '.internal', '.corp', '.home', '.arpa', '.onion']

/**
 * SSRF guard for an attacker-influenced outbound URL. Used for the LOD source
 * URLs from the SQS job — the worker, Unity and the encoder fetch these, so a
 * job pointing at `http://169.254.169.254/...` or an internal host would turn
 * the converter into an SSRF primitive against cloud metadata / internal
 * services.
 *
 * Rejects IP-literal hosts (legit catalysts/CDNs use DNS names — this blocks the
 * metadata IP and internal IPs directly) and obvious loopback/internal names.
 * It does NOT pin a domain allowlist: LOD CDN hosts vary, so an allowlist risks
 * rejecting legit jobs. The content-server URL is the attacker-influenced field
 * that DOES get a strict host allowlist — see {@link isAllowedContentServerUrl}.
 * Code-level guards are inherently bypassable (obfuscated IPs, DNS rebinding) —
 * pair with an egress network control that blocks link-local/RFC1918 from the
 * conversion pods.
 */
export function isSafeOutboundUrl(raw: string): boolean {
  let u: URL
  try {
    u = new URL(raw)
  } catch {
    return false
  }
  // HTTPS only — LOD content must not be fetched over plaintext (no MITM /
  // protocol-downgrade tampering), matching the content-server requirement.
  if (u.protocol !== 'https:') return false
  const host = u.hostname.replace(/^\[|\]$/g, '').toLowerCase()
  if (host.length === 0) return false
  // IP-literal host (v4/v6) → reject: blocks the cloud-metadata IP
  // (169.254.169.254) and internal IPs; legit content/LOD servers are named.
  if (isIP(host) !== 0) return false
  // Loopback / internal-only TLDs that should never host public LOD content.
  if (host === 'localhost' || INTERNAL_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix))) {
    return false
  }
  return true
}

/**
 * Normalize one allowlist entry to a bare lowercase hostname. Accepts either a
 * bare host (`peer.decentraland.org`) or a full URL (`https://peer…/content`) —
 * the latter is tolerated because the sibling `deployments-to-sqs` config lists
 * content servers as full URLs, so an operator copying that format won't
 * silently produce an empty allowlist. Returns undefined for blank/unparseable
 * entries so the caller can drop them.
 */
function normalizeContentServerHost(entry: string): string | undefined {
  const trimmed = entry.trim().toLowerCase()
  if (trimmed.length === 0) return undefined
  if (trimmed.includes('/')) {
    try {
      const withScheme = /^[a-z][a-z0-9+.-]*:\/\//.test(trimmed) ? trimmed : `https://${trimmed}`
      const host = new URL(withScheme).hostname.replace(/^\[|\]$/g, '').toLowerCase()
      return host.length > 0 ? host : undefined
    } catch {
      return undefined
    }
  }
  return trimmed
}

/**
 * Parse the `ALLOWED_CONTENT_SERVER_HOSTS` env var (a comma-separated list of catalyst
 * hosts) into a Set of normalized hostnames for {@link isAllowedContentServerUrl}.
 * There is no built-in fallback list: the allowlist is sourced entirely from
 * config (set per-environment in the `definitions` repo), so the orchestrator
 * requires the var and rejects an empty result at startup rather than silently
 * running with no allowlist.
 */
export function parseAllowedContentServerHosts(raw: string | undefined): Set<string> {
  const hosts = (raw ?? '')
    .split(',')
    .map(normalizeContentServerHost)
    .filter((h): h is string => h !== undefined)
  return new Set(hosts)
}

/**
 * Strict SSRF guard for the content-server URL of an SQS job: requires HTTPS and
 * an exact host match against the configured catalyst allowlist. An exact match
 * (not a suffix) is intentional — it's the whole point of an allowlist and the
 * catalyst hosts are a known finite set (issue #306).
 */
export function isAllowedContentServerUrl(raw: string, allowedHosts: Set<string>): boolean {
  let u: URL
  try {
    u = new URL(raw)
  } catch {
    return false
  }
  if (u.protocol !== 'https:') return false
  const host = u.hostname.replace(/^\[|\]$/g, '').toLowerCase()
  return allowedHosts.has(host)
}

export function getAbVersionEnvName(buildTarget: string) {
  switch (buildTarget) {
    case 'webgl':
      return 'AB_VERSION'
    case 'windows':
      return 'AB_VERSION_WINDOWS'
    case 'mac':
      return 'AB_VERSION_MAC'
    default:
      throw 'Invalid buildTarget'
  }
}
