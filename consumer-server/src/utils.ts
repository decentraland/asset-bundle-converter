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

/**
 * SSRF guard for an attacker-influenced outbound URL (the content-server base
 * and LOD source URLs from the SQS job). The worker — and Unity, and the
 * encoder — fetch these, so a job pointing at `http://169.254.169.254/...` or
 * an internal host would turn the converter into an SSRF primitive against
 * cloud metadata / internal services.
 *
 * Rejects IP-literal hosts (legit catalysts/CDNs use DNS names — this blocks the
 * metadata IP and internal IPs directly) and obvious loopback/internal names.
 * It does NOT pin a domain allowlist (LOD CDN hosts vary, so an allowlist risks
 * rejecting legit jobs); a `.decentraland.org`-suffix allowlist could be layered
 * on for the content-server URL specifically. Code-level guards are inherently
 * bypassable (obfuscated IPs, DNS rebinding) — pair with an egress network
 * control that blocks link-local/RFC1918 from the conversion pods.
 */
export function isSafeOutboundUrl(raw: string): boolean {
  let u: URL
  try {
    u = new URL(raw)
  } catch {
    return false
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return false
  const host = u.hostname.replace(/^\[|\]$/g, '').toLowerCase()
  if (host.length === 0) return false
  // IP-literal host (v4/v6) → reject: blocks the cloud-metadata IP
  // (169.254.169.254) and internal IPs; legit content/LOD servers are named.
  if (isIP(host) !== 0) return false
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) {
    return false
  }
  return true
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
