/**
 * Codes that cross the napi-rs boundary as the `CODE: detail` prefix of a
 * thrown error's `.message`. Mirrors `EncoderError::code()` on the Rust side —
 * see `encoder/src/errors.rs`. Add new codes in both places.
 *
 * The scene-converter treats {TARGET_MISMATCH, INVALID_BAKE, NOT_STARTED} as
 * misconfig — no Unity fallback (a retry wouldn't help). Every other code
 * (INTERNAL, MISSING_DEPS_DIGEST, LOD_UNSUPPORTED, UNKNOWN) falls back to Unity
 * when ENCODER_FALLBACK_TO_UNITY=true.
 */
export type EncoderErrorCode =
  | 'NOT_STARTED'
  | 'TARGET_MISMATCH'
  | 'INVALID_BAKE'
  | 'MISSING_DEPS_DIGEST'
  | 'LOD_UNSUPPORTED'
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
   * Translate a napi-rs error into an EncoderError. The native layer formats
   * the message as "CODE: detail" (see encoder src/errors.rs::napi_message) —
   * napi maps the Rust `Error.reason` to the JS `.message`, and the JS `.code`
   * is the napi Status (not our code), so parse the code off the message prefix.
   * Falls back to 'INTERNAL' for native errors that escape the typed boundary.
   */
  static fromNative(err: unknown): EncoderError {
    if (err instanceof Error) {
      const sep = err.message.indexOf(': ')
      const maybeCode = sep > 0 ? err.message.slice(0, sep) : err.message
      if (isEncoderErrorCode(maybeCode)) {
        // Only strip the prefix when a separator was actually found, else a
        // bare-code message ("INTERNAL") would lose its first char to slice(1).
        const detail = sep > 0 ? err.message.slice(sep + 2) : err.message
        return new EncoderError(detail, { code: maybeCode })
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
    s === 'LOD_UNSUPPORTED' ||
    s === 'INTERNAL'
  )
}
