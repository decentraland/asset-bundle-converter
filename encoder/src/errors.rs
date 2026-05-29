use thiserror::Error;

/// Top-level encoder error. Mapped at the napi-rs boundary onto JS
/// `EncoderError` instances whose `code` field drives the consumer-server's
/// fallback decision (see scene-converter/component.ts).
///
/// Tier separation:
/// * Encoder-wide failures (`TargetMismatch`, `InvalidBake`, `NotStarted`,
///   `OutOfMemory`, `Internal`) reject the `encode()` promise — the
///   TS-side scene-converter then decides whether to fall back to Unity
///   based on `ENCODER_FALLBACK_TO_UNITY`.
/// * Per-asset failures (a single glb is unparseable, a texture's deps are
///   missing) are returned in `SceneOutput.partial_failures` and never
///   reject — they mirror Unity's `failingConversionTolerance` behaviour.
#[derive(Debug, Error)]
pub enum EncoderError {
    #[error("encoder not started — call create_encoder() before encode()")]
    NotStarted,

    #[error("build target mismatch: encoder configured for {configured:?}, request asked for {requested:?}")]
    TargetMismatch {
        configured: crate::types::BuildTarget,
        requested: crate::types::BuildTarget,
    },

    /// Bake artifacts couldn't be loaded or parsed at startup.
    /// Surfaces as a fail-fast on pod start; never happens mid-conversion.
    #[error("invalid bake artifacts: {0}")]
    InvalidBake(String),

    #[error("missing per-glb deps digest for hash {hash}")]
    MissingDepsDigest { hash: String },

    #[error("out of memory")]
    OutOfMemory,

    /// Catch-all for unexpected encoder bugs. Mapped to
    /// `code: 'INTERNAL'` on the JS side, which is the only code that the
    /// `ENCODER_FALLBACK_TO_UNITY` flag actually catches for fallback —
    /// the others indicate misconfiguration we don't want to paper over.
    #[error("internal encoder error: {0}")]
    Internal(String),
}

impl EncoderError {
    /// Stable code surfaced to the JS side. Keeping this stable across
    /// versions matters because the scene-converter's metric labels
    /// (`ab_converter_encoder_errors_total{code=...}`) and the SRE alert
    /// rules in the Grafana dashboards reference these strings.
    pub fn code(&self) -> &'static str {
        match self {
            EncoderError::NotStarted => "NOT_STARTED",
            EncoderError::TargetMismatch { .. } => "TARGET_MISMATCH",
            EncoderError::InvalidBake(_) => "INVALID_BAKE",
            EncoderError::MissingDepsDigest { .. } => "MISSING_DEPS_DIGEST",
            EncoderError::OutOfMemory => "OUT_OF_MEMORY",
            EncoderError::Internal(_) => "INTERNAL",
        }
    }
}

/// Convert encoder errors into napi-rs errors carrying the stable `code`
/// in the JS Error's `code` property. The TS side reads this to decide
/// fallback eligibility — keep the mapping verbatim.
///
/// Gated behind `napi-bindings` so plain-Rust consumers of this crate
/// (the `extract-typetrees` binary) don't need to link napi.
#[cfg(feature = "napi-bindings")]
impl From<EncoderError> for napi::Error {
    fn from(err: EncoderError) -> Self {
        let status = match err {
            EncoderError::OutOfMemory => napi::Status::GenericFailure,
            _ => napi::Status::GenericFailure,
        };
        let mut e = napi::Error::new(status, err.to_string());
        e.reason = err.code().to_string();
        e
    }
}
