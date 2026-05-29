/**
 * Codes that cross the napi-rs boundary on the `.code` field of thrown
 * errors. Mirrors `EncoderError::code()` on the Rust side — see
 * `encoder/src/errors.rs`. Add new codes in both places.
 *
 * The scene-converter logic component reads `code === 'INTERNAL'` to decide
 * whether to fall back to Unity (when ENCODER_FALLBACK_TO_UNITY=true). The
 * other codes indicate misconfiguration that fallback wouldn't help.
 */
export type EncoderErrorCode =
  | 'NOT_STARTED'
  | 'TARGET_MISMATCH'
  | 'INVALID_BAKE'
  | 'MISSING_DEPS_DIGEST'
  | 'OUT_OF_MEMORY'
  | 'INTERNAL'

export class EncoderError extends Error {
  readonly code: EncoderErrorCode
  readonly context?: Record<string, unknown>

  constructor(message: string, opts: { code: EncoderErrorCode; context?: Record<string, unknown> }) {
    super(message)
    this.name = 'EncoderError'
    this.code = opts.code
    this.context = opts.context
  }

  /**
   * Translate a napi-rs error (whose `.reason` carries the Rust-side
   * `EncoderError::code()` string) into an EncoderError. Falls back to
   * 'INTERNAL' for native errors that escape the typed boundary —
   * those are encoder bugs we'd want fallback to catch.
   */
  static fromNative(err: unknown): EncoderError {
    if (err instanceof Error) {
      const code = (err as any).reason as EncoderErrorCode | undefined
      if (code && isEncoderErrorCode(code)) {
        return new EncoderError(err.message, { code })
      }
      return new EncoderError(err.message, { code: 'INTERNAL' })
    }
    return new EncoderError(String(err), { code: 'INTERNAL' })
  }
}

/** Thrown when bake artifact loading from S3 fails at component start. */
export class BakeArtifactError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'BakeArtifactError'
  }
}

function isEncoderErrorCode(s: string): s is EncoderErrorCode {
  return (
    s === 'NOT_STARTED' ||
    s === 'TARGET_MISMATCH' ||
    s === 'INVALID_BAKE' ||
    s === 'MISSING_DEPS_DIGEST' ||
    s === 'OUT_OF_MEMORY' ||
    s === 'INTERNAL'
  )
}
