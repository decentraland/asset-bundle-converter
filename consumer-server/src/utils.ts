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

/**
 * Wrap an async `fn` with a histogram observation. Uses the WKC metrics
 * `startTimer(name, labels)` → `{ end }` pattern; `end()` records elapsed
 * seconds into the named histogram. Called from `try { … } finally { end() }`
 * so a phase that throws is still measured — slow-then-fail looks the same
 * as slow-success on the dashboard, which is what you want for capacity
 * planning.
 *
 * @typeParam T - Resolved value of `fn`.
 * @param metrics - The metrics component (any subset of `IMetricsComponent`
 *   that exposes `startTimer`).
 * @param name - Histogram name as declared in `metricDeclarations`.
 * @param labels - Label values matching the histogram's `labelNames`.
 * @param fn - The async work whose duration is recorded.
 */
export async function withPhaseTimer<T>(
  metrics: { startTimer: (name: any, labels?: any) => { end: () => void } },
  name: string,
  labels: Record<string, string>,
  fn: () => Promise<T>
): Promise<T> {
  const { end } = metrics.startTimer(name, labels)
  try {
    return await fn()
  } finally {
    end()
  }
}
