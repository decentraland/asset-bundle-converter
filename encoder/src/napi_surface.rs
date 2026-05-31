//! napi-rs surface — Node native module bindings.
//!
//! Behind `#[cfg(feature = "napi-bindings")]` (set in Cargo.toml's
//! default features) so binaries under `src/bin/` can link the
//! encoder's modules as a plain Rust library without dragging in
//! napi-rs's Node-host-only symbols. The default `cargo build` and
//! `napi build` invocations still produce the full cdylib with this
//! surface included.

use std::sync::Arc;

use napi::bindgen_prelude::*;
use napi_derive::napi;
use tokio::sync::Semaphore;

use crate::errors::EncoderError;
use crate::scene_encoder::{self, SceneEncoderInner};
use crate::types::{self, BakeInfo, BuildTarget, ShaderManifest};

// ---------------------------------------------------------------------------
// EncoderConfig — the napi-rs object passed into `create_encoder`. Names
// chosen to match the TS adapter (`asset-bundle-encoder/types.ts`).
// ---------------------------------------------------------------------------

#[napi(object)]
pub struct EncoderConfig {
    /// "windows" | "mac" | "webgl"
    pub build_target: String,
    /// Current AB_VERSION (e.g. "v48"). Embedded into bundle metadata so a
    /// pod misconfigured for the wrong AB version surfaces at startup
    /// rather than producing dead bundles.
    pub ab_version: String,
    pub bake_artifacts: NapiBakeArtifacts,
    /// Process-global cap on parallel catalyst fetches across all encode()
    /// calls. Default 64; tunable via ENCODER_FETCH_CONCURRENCY in the
    /// TS-side adapter.
    pub max_concurrent_fetches: Option<u32>,
    /// Per-scene fetch parallelism (analogue of Unity's downloadBatchSize).
    /// Default 16.
    pub per_scene_fetch_concurrency: Option<u32>,
}

#[napi(object)]
pub struct NapiBakeArtifacts {
    /// TypeTree fixture binary (output of the `extract-typetrees` CLI).
    /// Loaded once, parsed into the internal TypeTreeDb that the scene
    /// encoder dispatches on.
    pub type_trees: Buffer,
    /// JSON shader manifest: `{ shaderName: { guid, pathId, type } }`.
    /// Bytes rather than a typed Record so the TS side doesn't have to
    /// know the per-entry shape — keeps the napi-rs boundary one object
    /// type narrower.
    pub shader_manifest_json: Buffer,
    /// JSON metadata about the bake (Unity version, bake date, etc.).
    /// Logged at startup; not used for any runtime decisions.
    pub bake_info_json: Buffer,
}

#[napi(object)]
pub struct NapiSceneInput {
    pub entity_id: String,
    /// Entity DTO type ("scene" | "emote" | "wearable" | …). Drives the
    /// animation method (emote → Mecanim, wearable → None, else Legacy),
    /// alongside the `_emote.glb` filename rule. Optional — absent → scene.
    pub entity_type: Option<String>,
    /// "dcl" | "gltfast"
    pub shader_type: String,
    /// Already trailing-slashed catalyst contents URL
    /// (e.g. "https://peer.decentraland.org/content/contents/").
    pub catalyst_base_url: String,
    pub content_map: Vec<NapiContentEntry>,
    pub deps_digest_by_hash: std::collections::HashMap<String, String>,
    pub cached_hashes: Vec<String>,
    pub skipped_hashes: Vec<String>,
    /// 0.05 = tolerate up to 5% failed assets. Matches Unity's
    /// failingConversionTolerance default.
    pub failure_tolerance: f64,
}

#[napi(object)]
pub struct NapiContentEntry {
    pub file: String,
    pub hash: String,
}

#[napi(object)]
pub struct NapiSceneOutput {
    pub bundles: Vec<NapiBundle>,
    pub partial_failures: Vec<NapiPartialFailure>,
    pub stats: NapiEncodeStats,
    pub logs: Vec<NapiLogEntry>,
}

#[napi(object)]
pub struct NapiBundle {
    pub source_hash: String,
    pub bundle_name: String,
    pub dependencies: Vec<String>,
    pub uncompressed_bytes: Buffer,
}

#[napi(object)]
pub struct NapiPartialFailure {
    pub hash: String,
    pub reason: String,
    pub message: String,
}

#[napi(object)]
pub struct NapiEncodeStats {
    pub total_gltf: u32,
    pub encoded_gltf: u32,
    pub total_textures: u32,
    pub encoded_textures: u32,
    pub cached_skipped: u32,
    pub broken_skipped: u32,
    pub encode_wall_ms: u32,
}

#[napi(object)]
pub struct NapiLogEntry {
    pub level: String,
    pub message: String,
}

#[napi]
pub struct Encoder {
    inner: Arc<SceneEncoderInner>,
    configured_target: BuildTarget,
}

#[napi]
impl Encoder {
    #[napi]
    pub async fn encode(&self, input: NapiSceneInput) -> Result<NapiSceneOutput> {
        let requested_target = input
            .shader_type
            .parse::<types::ShaderType>()
            .map_err(|e| napi::Error::new(Status::InvalidArg, format!("invalid shader_type: {}", e)))?;
        let _ = requested_target;

        let scene_input = scene_encoder::SceneInput {
            entity_id: input.entity_id,
            entity_type: input.entity_type,
            shader_type: input
                .shader_type
                .parse()
                .map_err(|e: String| napi::Error::new(Status::InvalidArg, format!("invalid shader_type: {e}")))?,
            catalyst_base_url: input.catalyst_base_url,
            content_map: input
                .content_map
                .into_iter()
                .map(|c| scene_encoder::ContentEntry {
                    file: c.file,
                    hash: c.hash,
                })
                .collect(),
            deps_digest_by_hash: input.deps_digest_by_hash,
            cached_hashes: input.cached_hashes,
            skipped_hashes: input.skipped_hashes,
            failure_tolerance: input.failure_tolerance,
        };

        let inner = self.inner.clone();
        let output = inner.encode(scene_input).await?;

        Ok(NapiSceneOutput {
            bundles: output
                .bundles
                .into_iter()
                .map(|b| NapiBundle {
                    source_hash: b.source_hash,
                    bundle_name: b.bundle_name,
                    dependencies: b.dependencies,
                    uncompressed_bytes: Buffer::from(b.uncompressed_bytes),
                })
                .collect(),
            partial_failures: output
                .partial_failures
                .into_iter()
                .map(|p| NapiPartialFailure {
                    hash: p.hash,
                    reason: p.reason,
                    message: p.message,
                })
                .collect(),
            stats: NapiEncodeStats {
                total_gltf: output.stats.total_gltf,
                encoded_gltf: output.stats.encoded_gltf,
                total_textures: output.stats.total_textures,
                encoded_textures: output.stats.encoded_textures,
                cached_skipped: output.stats.cached_skipped,
                broken_skipped: output.stats.broken_skipped,
                encode_wall_ms: output.stats.encode_wall_ms.min(u32::MAX as u64) as u32,
            },
            logs: output
                .logs
                .into_iter()
                .map(|l| NapiLogEntry {
                    level: l.level,
                    message: l.message,
                })
                .collect(),
        })
    }

    #[napi]
    pub fn build_target(&self) -> String {
        self.configured_target.filename_suffix().trim_start_matches('_').to_string()
    }
}

#[napi]
pub async fn create_encoder(config: EncoderConfig) -> Result<Encoder> {
    let build_target: BuildTarget = config
        .build_target
        .parse()
        .map_err(|e: String| napi::Error::new(Status::InvalidArg, e))?;

    let shader_manifest: ShaderManifest =
        serde_json::from_slice(config.bake_artifacts.shader_manifest_json.as_ref())
            .map_err(|e| EncoderError::InvalidBake(format!("shader_manifest_json: {e}")))?;

    let bake_info: BakeInfo = serde_json::from_slice(config.bake_artifacts.bake_info_json.as_ref())
        .map_err(|e| EncoderError::InvalidBake(format!("bake_info_json: {e}")))?;

    if config.bake_artifacts.type_trees.as_ref().is_empty() {
        return Err(EncoderError::InvalidBake("type_trees is empty".into()).into());
    }

    // Parse the typetrees.bin fixture once at startup. Per-class
    // writers (texture, eventually mesh / material / etc.) look up
    // their class's TypeTree from this DB at encode time.
    let type_tree_db = crate::encode::type_tree_db::TypeTreeDb::from_fixture_bytes(
        config.bake_artifacts.type_trees.as_ref(),
    )
    .map_err(|e| EncoderError::InvalidBake(format!("typetrees.bin: {e}")))?;

    let max_concurrent = config.max_concurrent_fetches.unwrap_or(64) as usize;
    let per_scene = config.per_scene_fetch_concurrency.unwrap_or(16) as usize;

    let inner = SceneEncoderInner {
        build_target,
        ab_version: config.ab_version,
        shader_manifest,
        type_tree_db: Arc::new(type_tree_db),
        fetch_semaphore: Arc::new(Semaphore::new(max_concurrent)),
        per_scene_fetch_concurrency: per_scene,
    };

    tracing::info!(
        unity_version = %bake_info.unity_version,
        bake_version = %bake_info.bake_version,
        bake_date = %bake_info.bake_date,
        build_target = ?build_target,
        shaders = inner.shader_manifest.entries.len(),
        type_tree_classes = inner.type_tree_db.class_ids().len(),
        max_concurrent_fetches = max_concurrent,
        per_scene_fetch_concurrency = per_scene,
        "asset-bundle-encoder initialised"
    );

    Ok(Encoder {
        inner: Arc::new(inner),
        configured_target: build_target,
    })
}
