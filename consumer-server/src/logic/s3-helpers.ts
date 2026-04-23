/**
 * Recognize the "object does not exist" shape across AWS SDK v2 responses.
 *
 * The SDK surfaces the same semantic condition through a few different fields
 * depending on the operation and error path, so callers checking "is this a
 * not-found?" need to accept all of them to avoid treating a benign 404 as a
 * hard failure. This helper is the single source of truth for the predicate —
 * don't inline the shape checks at call sites.
 *
 * @param err - Any value caught from an S3 promise rejection.
 * @returns `true` when the error represents a missing object (404 /
 *          `NotFound` / `NoSuchKey`), `false` otherwise (including `null`,
 *          `undefined`, and non-S3 errors).
 */
export function isS3NotFound(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false
  const e = err as { statusCode?: number; code?: string }
  return e.statusCode === 404 || e.code === 'NotFound' || e.code === 'NoSuchKey'
}
