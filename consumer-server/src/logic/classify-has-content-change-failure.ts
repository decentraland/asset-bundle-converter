// Classify a hasContentChange() failure into a bounded-cardinality reason
// string suitable for use as a Prometheus label. The classification is
// best-effort — we don't get structured error objects from the fetch/node-fetch
// layer, only `Error` instances whose message text varies across failure
// modes.
//
// Label cardinality is deliberately small and fixed: 'timeout' | 'network' |
// 'bad_request' | 'server_error' | 'other'. New reasons must be added here,
// not invented at call sites.

export type HasContentChangeFailureReason = 'timeout' | 'network' | 'bad_request' | 'server_error' | 'other'

export function classifyHasContentChangeFailure(err: unknown): HasContentChangeFailureReason {
  const raw = err instanceof Error ? err.message : String(err ?? '')
  const message = raw.toLowerCase()

  // Check timeout and network errors before the HTTP status regex — error
  // strings like "timeout after 500ms" would otherwise false-match as 5xx.
  if (message.includes('timeout') || message.includes('etimedout')) return 'timeout'
  if (message.includes('econnrefused') || message.includes('enotfound') || message.includes('fetch failed')) {
    return 'network'
  }
  if (message.includes('bad request') || message.includes('invalid request') || /\b400\b/.test(message)) {
    return 'bad_request'
  }
  if (/\bstatus\s*:?\s*5\d\d\b/.test(message) || /\b5\d\d\s/.test(message)) return 'server_error'
  return 'other'
}
