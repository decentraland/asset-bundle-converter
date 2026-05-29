//! Decentraland AssetBundle encoder library.
//!
//! Two consumers:
//!   * The Node native module (consumer-server's adapter) — uses the
//!     napi-rs surface in `napi_surface.rs`, gated behind the
//!     `napi-bindings` feature (default-on).
//!   * The `extract-typetrees` binary under `src/bin/` — uses
//!     `catalyst_client` + `encode` as a plain Rust library, built
//!     with `--no-default-features` so napi-rs's Node-host symbols
//!     don't need to resolve.
//!
//! `cargo test --lib` runs without the feature unless invoked with
//! `--features napi-bindings`. The Rust unit tests don't touch the
//! napi surface; the lib's behaviour is identical either way.

// `pub` so any future Rust embedder of the policy can call into the
// catalyst client directly. Cross-side parity test lives inline in
// `catalyst_client::tests`.
pub mod catalyst_client;
// `pub` so the `extract-typetrees` binary at src/bin/extract-typetrees.rs
// can use the submodule readers.
pub mod encode;
mod errors;
mod scene_encoder;
// Public: the assembler API (`assemble_glb_bundle`, `assemble_texture_bundle`)
// takes `BuildTarget`, so callers and verifier binaries need it.
pub mod types;

// napi-rs surface — gated so the lib stays linkable from src/bin/ targets.
#[cfg(feature = "napi-bindings")]
mod napi_surface;
