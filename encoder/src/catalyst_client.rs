//! Catalyst HTTP client mirroring the TS-side policy in
//! `consumer-server/src/logic/asset-reuse.ts:460-838`.
//!
//! Why a verbatim mirror: during rollout the encoder and Unity paths run
//! against the same catalysts and CDN. Divergent retry/backoff/timeout
//! behaviour would show up as a per-pod difference in catalyst pressure
//! that's painful to diagnose. The constants and decisions in this file
//! are intentionally identical to the TS side — if the TS side bumps
//! anything, this file MUST be updated in the same PR.
//!
//! What's deliberately NOT mirrored:
//! - `readGlbJsonPrefix` (asset-reuse.ts:706-767) is digester-specific;
//!   the encoder needs the full glb body, never the JSON-prefix subset.
//! - The catalyst entity fetcher (`fetchActiveEntity` in
//!   catalyst/component.ts:12-45) stays in TS — one-shot, no retry,
//!   per-call AbortController timeout. The encoder only fetches assets.

use std::time::Duration;

use bytes::Bytes;
use futures_util::StreamExt;
use reqwest::{Client, Response, StatusCode};
use thiserror::Error;
use tokio::time::sleep;

// ---------------------------------------------------------------------------
// Policy constants — mirror asset-reuse.ts:467-475 exactly.
//
// If any of these change on the TS side, bump them here in the same PR. The
// cross-side parity test (see tests below) will catch drift on attempts /
// retry-after cap; the byte limit and base ms it can't catch directly — keep
// the two literal sites in sync manually.
// ---------------------------------------------------------------------------

/// 256 MiB upper bound on a single asset download — asset-reuse.ts:467.
pub const MAX_GLTF_DOWNLOAD_BYTES: usize = 256 * 1024 * 1024;

/// 1 initial attempt + 2 retries — asset-reuse.ts:469.
pub const GLTF_FETCH_ATTEMPTS: u32 = 3;

/// Base of the exponential backoff in ms — asset-reuse.ts:470.
pub const GLTF_FETCH_RETRY_BASE_MS: u64 = 250;

/// Server-supplied `Retry-After` clamped to this maximum — asset-reuse.ts:475.
pub const MAX_RETRY_AFTER_MS: u64 = 30_000;

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/// Mirrors the `NonRetryableFetchError` / `RetryableFetchError` split at
/// asset-reuse.ts:486-496. The retryable variant carries an optional
/// server hint so `with_fetch_retries` can prefer it over the exponential
/// formula — same precedence as `withFetchRetries` at line 779-792.
#[derive(Debug, Error, Clone)]
pub enum FetchError {
    #[error("non-retryable: {0}")]
    NonRetryable(String),
    #[error("retryable: {msg}")]
    Retryable {
        msg: String,
        /// Set when `assert_ok_response` parsed a `Retry-After` header
        /// from a 408/429/5xx response; otherwise None and the caller
        /// falls back to `retry_delay_ms`.
        retry_after_ms: Option<u64>,
    },
}

impl FetchError {
    pub fn is_retryable(&self) -> bool {
        matches!(self, FetchError::Retryable { .. })
    }

    fn retry_after_ms(&self) -> Option<u64> {
        match self {
            FetchError::Retryable { retry_after_ms, .. } => *retry_after_ms,
            _ => None,
        }
    }
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

#[derive(Debug, Clone)]
pub struct CatalystClient {
    http: Client,
    /// Already trailing-slashed, matches the TS-side
    /// `normalizeContentsBaseUrl` invariant.
    base_url: String,
}

impl CatalystClient {
    pub fn new(base_url: String) -> Self {
        // Ensure trailing slash so `{base}{hash}` produces a valid URL.
        // Caller is expected to pass the normalised form, but defending
        // here keeps the client robust against accidental drift in the TS
        // adapter.
        let base_url = if base_url.ends_with('/') {
            base_url
        } else {
            format!("{base_url}/")
        };

        let http = Client::builder()
            .user_agent(concat!(
                "dcl-asset-bundle-encoder/",
                env!("CARGO_PKG_VERSION")
            ))
            .pool_max_idle_per_host(16)
            // Per-request timeout — the TS side bounds individual catalyst
            // calls via AbortController; this is the symmetric reqwest knob.
            // Matches `MAX_RETRY_AFTER_MS` philosophically: anything longer
            // is a wedged catalyst that SQS will retry.
            .timeout(Duration::from_secs(30))
            // Don't decompress .glb bodies on the wire (see is_glb branch
            // in fetch_once). gzip is enabled by Cargo.toml; we only opt
            // in via Accept-Encoding for .gltf.
            .build()
            .expect("reqwest client builder cannot fail with these settings");

        Self { http, base_url }
    }

    /// Fetch the bytes for a single content hash. `is_glb` controls the
    /// `Accept-Encoding: identity` header — `.glb` requests force identity
    /// to keep transit byte-for-byte aligned with the binary GLB layout
    /// (mirrors `defaultGltfFetcher` at asset-reuse.ts:827-838).
    pub async fn fetch_asset(&self, hash: &str, is_glb: bool) -> Result<Bytes, FetchError> {
        let url = format!("{}{}", self.base_url, hash);
        let url_owned = url.clone();
        let http = self.http.clone();
        with_fetch_retries(move |attempt| {
            let fetch_url = if attempt == 0 {
                url_owned.clone()
            } else {
                with_retry_query_param(&url_owned, attempt)
            };
            let log_url = url_owned.clone();
            let http = http.clone();
            async move { fetch_once(&http, &log_url, &fetch_url, is_glb).await }
        })
        .await
    }
}

async fn fetch_once(
    http: &Client,
    log_url: &str,
    fetch_url: &str,
    is_glb: bool,
) -> Result<Bytes, FetchError> {
    let mut req = http.get(fetch_url);
    if is_glb {
        // Mirrors asset-reuse.ts:830. .glb is already binary; gzip transit
        // saves nothing and complicates Stream truncation detection.
        req = req.header("Accept-Encoding", "identity");
    }
    let res = req.send().await.map_err(|e| FetchError::Retryable {
        msg: format!("transport error on {log_url}: {e}"),
        retry_after_ms: None,
    })?;

    assert_ok_response(log_url, &res)?;
    assert_declared_length_within_guard(log_url, &res)?;
    read_whole_response(log_url, res).await
}

// ---------------------------------------------------------------------------
// Status classification — mirrors `assertOkResponse` (asset-reuse.ts:567-576).
// ---------------------------------------------------------------------------

fn assert_ok_response(url: &str, res: &Response) -> Result<(), FetchError> {
    if res.status().is_success() {
        return Ok(());
    }
    let status = res.status();
    let msg = format!(
        "failed to fetch {url}: {} {}",
        status.as_u16(),
        status.canonical_reason().unwrap_or("")
    );
    // 408 Request Timeout, 429 Too Many Requests, all 5xx — same set as
    // asset-reuse.ts:570.
    let is_retryable = status == StatusCode::REQUEST_TIMEOUT
        || status == StatusCode::TOO_MANY_REQUESTS
        || status.as_u16() >= 500;
    if is_retryable {
        let retry_after_ms = parse_retry_after_ms(
            res.headers()
                .get(reqwest::header::RETRY_AFTER)
                .and_then(|v| v.to_str().ok()),
        );
        Err(FetchError::Retryable {
            msg,
            retry_after_ms,
        })
    } else {
        Err(FetchError::NonRetryable(msg))
    }
}

// ---------------------------------------------------------------------------
// Content-Length guard — mirrors `assertDeclaredLengthWithinGuard`
// (asset-reuse.ts:581-588).
// ---------------------------------------------------------------------------

fn assert_declared_length_within_guard(url: &str, res: &Response) -> Result<(), FetchError> {
    if let Some(len) = res.content_length() {
        if len as usize > MAX_GLTF_DOWNLOAD_BYTES {
            return Err(FetchError::NonRetryable(format!(
                "glb/gltf at {url} declared Content-Length {len} > {MAX_GLTF_DOWNLOAD_BYTES} (refusing to buffer)"
            )));
        }
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Body read — mirrors `readWholeStream` (asset-reuse.ts:662-701).
//
// Truncation (streamed total < declared Content-Length) is classified as
// `RetryableFetchError`: the underlying bytes at this CID are unchanged,
// the catalyst/CDN just dropped the connection. Same treatment as TS side
// at asset-reuse.ts:694-698.
// ---------------------------------------------------------------------------

async fn read_whole_response(url: &str, res: Response) -> Result<Bytes, FetchError> {
    let declared = res.content_length();

    let mut stream = res.bytes_stream();
    let mut buf = bytes::BytesMut::with_capacity(declared.unwrap_or(0) as usize);
    while let Some(chunk) = stream.next().await {
        let bytes = chunk.map_err(|e| FetchError::Retryable {
            msg: format!("stream read on {url}: {e}"),
            retry_after_ms: None,
        })?;
        if buf.len() + bytes.len() > MAX_GLTF_DOWNLOAD_BYTES {
            return Err(FetchError::NonRetryable(format!(
                "glb/gltf at {url} streamed {} bytes > {MAX_GLTF_DOWNLOAD_BYTES} (refusing to buffer)",
                buf.len() + bytes.len()
            )));
        }
        buf.extend_from_slice(&bytes);
    }

    if let Some(expected) = declared {
        if (buf.len() as u64) < expected {
            return Err(FetchError::Retryable {
                msg: format!(
                    "glb/gltf at {url} ended after {} bytes, before declared Content-Length {expected}",
                    buf.len()
                ),
                retry_after_ms: None,
            });
        }
    }

    Ok(buf.freeze())
}

// ---------------------------------------------------------------------------
// Retry-After parsing — mirrors `parseRetryAfterMs` (asset-reuse.ts:512-537).
//
// Behaviour to preserve, by case:
// 1. None / empty             → None (caller uses retry_delay_ms).
// 2. Digits only ("120")      → Some(120_000), clamped [0, MAX_RETRY_AFTER_MS].
// 3. Has letters (HTTP-date)  → Some(parsed delta), clamped [0, cap].
// 4. No letters, not digits   → None (rejects "-1", "1.5" — see line 531).
// 5. Unparseable HTTP-date    → None.
// 6. Past HTTP-date (skew)    → Some(0) (clamped lower bound).
// ---------------------------------------------------------------------------

/// Parse an HTTP `Retry-After` header value into milliseconds. Returns
/// `None` for absent/empty/unparseable inputs — the caller (`with_fetch_retries`)
/// falls back to `retry_delay_ms` in that case.
pub fn parse_retry_after_ms(raw: Option<&str>) -> Option<u64> {
    let trimmed = raw?.trim();
    if trimmed.is_empty() {
        return None;
    }

    // Case 2: digits-only delta-seconds. Mirrors `/^\d+$/.test(trimmed)` and
    // the `Number(trimmed)` parse at asset-reuse.ts:521-524. Saturating to
    // avoid u64 overflow on absurdly large values (TS clamps via Math.min).
    if trimmed.chars().all(|c| c.is_ascii_digit()) {
        let secs: u64 = trimmed.parse().ok()?;
        return Some(secs.saturating_mul(1000).min(MAX_RETRY_AFTER_MS));
    }

    // Case 4: anything without a letter and not digit-only is an invalid
    // numeric (`"-1"`, `"1.5"`) — same guard as asset-reuse.ts:531.
    if !trimmed.chars().any(|c| c.is_ascii_alphabetic()) {
        return None;
    }

    // Case 3: HTTP-date. Parse, subtract now, clamp to [0, cap]. Negative
    // deltas (clock skew, date already in the past) collapse to 0 — same
    // as `Math.max(0, delta)` at asset-reuse.ts:536.
    let parsed = httpdate::parse_http_date(trimmed).ok()?;
    let date_ms = parsed
        .duration_since(std::time::UNIX_EPOCH)
        .ok()?
        .as_millis() as i128;
    let now_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .ok()?
        .as_millis() as i128;
    let delta = (date_ms - now_ms).max(0).min(MAX_RETRY_AFTER_MS as i128) as u64;
    Some(delta)
}

// ---------------------------------------------------------------------------
// Backoff — mirrors `retryDelayMs` (asset-reuse.ts:622-625).
// Formula: base * 2^attempt + uniform[0, base) jitter.
// ---------------------------------------------------------------------------

fn retry_delay_ms(attempt: u32) -> u64 {
    use rand::Rng;
    // Match the JS jitter range [0, GLTF_FETCH_RETRY_BASE_MS).
    let jitter: u64 = rand::thread_rng().gen_range(0..GLTF_FETCH_RETRY_BASE_MS);
    GLTF_FETCH_RETRY_BASE_MS.saturating_mul(1u64 << attempt) + jitter
}

// ---------------------------------------------------------------------------
// Retry loop — mirrors `withFetchRetries` (asset-reuse.ts:779-792).
// Precedence: server `Retry-After` hint wins over the formula.
// ---------------------------------------------------------------------------

async fn with_fetch_retries<F, Fut>(mut f: F) -> Result<Bytes, FetchError>
where
    F: FnMut(u32) -> Fut,
    Fut: std::future::Future<Output = Result<Bytes, FetchError>>,
{
    let mut last_err: Option<FetchError> = None;
    for attempt in 0..GLTF_FETCH_ATTEMPTS {
        match f(attempt).await {
            Ok(v) => return Ok(v),
            Err(err) => {
                let is_last = attempt == GLTF_FETCH_ATTEMPTS - 1;
                if is_last || !err.is_retryable() {
                    return Err(err);
                }
                let hint = err.retry_after_ms();
                last_err = Some(err);
                let delay_ms = hint.unwrap_or_else(|| retry_delay_ms(attempt));
                sleep(Duration::from_millis(delay_ms)).await;
            }
        }
    }
    Err(last_err.expect("loop runs at least once"))
}

// ---------------------------------------------------------------------------
// CDN cachebust — mirrors `withRetryQueryParam` (asset-reuse.ts:802-806).
// Attempts > 0 append `?_retry=N`. The TS comment at lines 817-825
// explains why: poisoned CDN cache fills replay the broken body to every
// request landing on the same edge POP. Cachebust forces a fresh origin
// pull on the second attempt.
// ---------------------------------------------------------------------------

fn with_retry_query_param(url: &str, attempt: u32) -> String {
    let mut u = url::Url::parse(url).expect("base URL already validated by CatalystClient::new");
    u.query_pairs_mut()
        .append_pair("_retry", &attempt.to_string());
    u.to_string()
}

// ---------------------------------------------------------------------------
// Tests — one per policy branch documented above. All run against
// wiremock so they hit the same code paths as production.
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    // --- parse_retry_after_ms: drives the asset-reuse.ts:512-537 spec ----

    #[test]
    fn retry_after_none_when_absent() {
        assert_eq!(parse_retry_after_ms(None), None);
    }

    #[test]
    fn retry_after_none_when_empty_or_whitespace() {
        assert_eq!(parse_retry_after_ms(Some("")), None);
        assert_eq!(parse_retry_after_ms(Some("   ")), None);
    }

    #[test]
    fn retry_after_delta_seconds_converted_to_ms() {
        assert_eq!(parse_retry_after_ms(Some("0")), Some(0));
        assert_eq!(parse_retry_after_ms(Some("5")), Some(5_000));
        assert_eq!(parse_retry_after_ms(Some("30")), Some(30_000));
    }

    #[test]
    fn retry_after_delta_seconds_clamped_to_cap() {
        // 120s requested — should clamp to MAX_RETRY_AFTER_MS.
        assert_eq!(
            parse_retry_after_ms(Some("120")),
            Some(MAX_RETRY_AFTER_MS)
        );
        // Absurd value — saturating_mul prevents overflow, then clamp.
        assert_eq!(
            parse_retry_after_ms(Some("99999999999")),
            Some(MAX_RETRY_AFTER_MS)
        );
    }

    #[test]
    fn retry_after_rejects_negative_numeric() {
        // "-1" has no letters and isn't all-digits — rejected (asset-reuse.ts:531).
        assert_eq!(parse_retry_after_ms(Some("-1")), None);
    }

    #[test]
    fn retry_after_rejects_decimal() {
        // "1.5" has no letters and isn't all-digits — rejected.
        assert_eq!(parse_retry_after_ms(Some("1.5")), None);
    }

    #[test]
    fn retry_after_http_date_parses() {
        // A real HTTP-date in the future. Use a date a few hours ahead so the
        // (date - now) delta is positive but well under the 30s cap, then
        // verify it clamps to the cap (it's > cap, so the result is the cap).
        let future = httpdate::fmt_http_date(
            std::time::SystemTime::now() + std::time::Duration::from_secs(60 * 60),
        );
        assert_eq!(
            parse_retry_after_ms(Some(&future)),
            Some(MAX_RETRY_AFTER_MS)
        );
    }

    #[test]
    fn retry_after_http_date_in_past_clamps_to_zero() {
        // Clock-skew case: server sent a date that's already passed.
        let past = "Mon, 01 Jan 1990 00:00:00 GMT";
        assert_eq!(parse_retry_after_ms(Some(past)), Some(0));
    }

    #[test]
    fn retry_after_garbage_http_date_returns_none() {
        // Has letters so falls into the HTTP-date branch; httpdate fails.
        assert_eq!(parse_retry_after_ms(Some("not a date")), None);
    }

    // --- retry_delay_ms: formula at asset-reuse.ts:622-625 ----------------

    #[test]
    fn retry_delay_ms_bounds() {
        // Attempt 0: base + jitter ∈ [base, 2*base)
        for _ in 0..50 {
            let d = retry_delay_ms(0);
            assert!(d >= GLTF_FETCH_RETRY_BASE_MS);
            assert!(d < 2 * GLTF_FETCH_RETRY_BASE_MS);
        }
        // Attempt 1: 2*base + jitter ∈ [2*base, 3*base)
        for _ in 0..50 {
            let d = retry_delay_ms(1);
            assert!(d >= 2 * GLTF_FETCH_RETRY_BASE_MS);
            assert!(d < 3 * GLTF_FETCH_RETRY_BASE_MS);
        }
    }

    // --- with_retry_query_param: asset-reuse.ts:802-806 -------------------

    #[test]
    fn retry_query_param_appended() {
        let url = "https://peer.decentraland.org/content/contents/QmXYZ";
        assert_eq!(
            with_retry_query_param(url, 1),
            "https://peer.decentraland.org/content/contents/QmXYZ?_retry=1"
        );
    }

    #[test]
    fn retry_query_param_preserves_existing_query() {
        let url = "https://example.com/foo?bar=baz";
        let out = with_retry_query_param(url, 2);
        assert!(out.starts_with("https://example.com/foo?"));
        assert!(out.contains("bar=baz"));
        assert!(out.contains("_retry=2"));
    }

    // --- End-to-end against wiremock: each branch of assert_ok_response ----

    use wiremock::matchers::{method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    #[tokio::test]
    async fn fetches_2xx_body_successfully() {
        let server = MockServer::start().await;
        let body = b"hello world".to_vec();
        Mock::given(method("GET"))
            .and(path("/contents/QmABC"))
            .respond_with(ResponseTemplate::new(200).set_body_bytes(body.clone()))
            .mount(&server)
            .await;

        let client = CatalystClient::new(format!("{}/contents/", server.uri()));
        let bytes = client.fetch_asset("QmABC", false).await.unwrap();
        assert_eq!(bytes.as_ref(), body.as_slice());
    }

    #[tokio::test]
    async fn fails_non_retryable_on_404() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/contents/QmMISSING"))
            .respond_with(ResponseTemplate::new(404))
            .mount(&server)
            .await;

        let client = CatalystClient::new(format!("{}/contents/", server.uri()));
        let err = client.fetch_asset("QmMISSING", false).await.unwrap_err();
        assert!(
            matches!(err, FetchError::NonRetryable(_)),
            "expected NonRetryable on 404, got {err:?}"
        );
    }

    #[tokio::test]
    async fn retries_on_5xx_and_succeeds_with_cachebust() {
        let server = MockServer::start().await;
        // First request (?attempt=0, no _retry) → 503. Second (_retry=1) → 200.
        Mock::given(method("GET"))
            .and(path("/contents/QmFLAKY"))
            .respond_with(ResponseTemplate::new(503))
            .up_to_n_times(1)
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .and(path("/contents/QmFLAKY"))
            .respond_with(ResponseTemplate::new(200).set_body_bytes(b"recovered".to_vec()))
            .mount(&server)
            .await;

        let client = CatalystClient::new(format!("{}/contents/", server.uri()));
        let bytes = client.fetch_asset("QmFLAKY", false).await.unwrap();
        assert_eq!(bytes.as_ref(), b"recovered");
    }

    #[tokio::test]
    async fn gives_up_after_three_attempts() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/contents/QmDOWN"))
            .respond_with(ResponseTemplate::new(503))
            .mount(&server)
            .await;

        let client = CatalystClient::new(format!("{}/contents/", server.uri()));
        let err = client.fetch_asset("QmDOWN", false).await.unwrap_err();
        assert!(
            matches!(err, FetchError::Retryable { .. }),
            "expected Retryable on final attempt, got {err:?}"
        );
    }

    // The 256 MiB Content-Length guard isn't easily wiremock-testable —
    // hyper validates Content-Length against actual body length server-side
    // and refuses to let the mock lie. The guard's correctness comes from
    // the explicit `MAX_GLTF_DOWNLOAD_BYTES` constant + the unit-testable
    // policy in `assert_declared_length_within_guard`; tested by code
    // review rather than runtime. The TS-side equivalent in asset-reuse.ts
    // has the same property.

    // ---- Cross-side parity test --------------------------------------
    //
    // Reads the shared JSON fixture at `tests/fixtures/retry-after-cases.json`
    // that the TS-side spec at
    // `consumer-server/test/unit/retry-after-parity.spec.ts` also consumes.
    // Both sides drive their respective `parse_retry_after_ms` /
    // `parseRetryAfterMs` implementations against the same case set; any
    // drift between implementations surfaces here.
    //
    // Lives as an inline `#[test]` rather than an integration test
    // (`tests/retry_after_parity.rs`) because the crate's `cdylib` target
    // pulls in napi-rs symbols that are only resolved when loaded by Node
    // — `cargo test` against an integration test fails to link those.
    // Inline unit tests don't have that constraint because they compile
    // into the lib's test harness.

    #[derive(Debug, serde::Deserialize)]
    struct ParityCase {
        name: String,
        input: Option<String>,
        #[serde(rename = "expectedMs")]
        expected_ms: Option<u64>,
    }

    #[test]
    fn retry_after_parity_against_shared_fixture() {
        let fixture_path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("tests/fixtures/retry-after-cases.json");
        let payload = std::fs::read_to_string(&fixture_path)
            .unwrap_or_else(|e| panic!("read {fixture_path:?}: {e}"));
        let cases: Vec<ParityCase> =
            serde_json::from_str(&payload).unwrap_or_else(|e| panic!("parse fixture: {e}"));

        assert!(
            cases.len() >= 10,
            "parity fixture too small ({} cases) — TS side enforces the same floor",
            cases.len()
        );

        for case in &cases {
            let input_ref: Option<&str> = case.input.as_deref();
            let actual = parse_retry_after_ms(input_ref);
            assert_eq!(
                actual, case.expected_ms,
                "parity mismatch for case \"{}\" (input={:?}): expected {:?}, got {:?}",
                case.name, case.input, case.expected_ms, actual
            );
        }
    }
}
