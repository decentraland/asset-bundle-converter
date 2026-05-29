//! Scene-encoding pipeline.
//!
//! ⚠️ STATUS — partial. The boundary (fetch via `CatalystClient`, build the
//! glb dependency closure, classify assets, apply skip/cache filters,
//! enforce per-asset failure tolerance, assemble the SceneOutput) is
//! fully implemented. The actual UnityFS-encoder core (TypeTree-driven
//! serialization, mesh/texture/material binary writers, the LZ4 chunked
//! container format) is NOT — that's genuinely multi-month reverse-
//! engineering work and is intentionally left as a structured TODO map
//! rather than faked.
//!
//! See `TODO` comments in `encode_glb_bundle`, `encode_texture_bundle`,
//! and `serialize_unityfs_container` for the specific unknowns each
//! subsystem owns.

use std::collections::{HashMap, HashSet};
use std::sync::Arc;

use bytes::Bytes;
use serde::{Deserialize, Serialize};
use tokio::sync::Semaphore;

use crate::catalyst_client::{CatalystClient, FetchError};
use crate::encode::bundle_assembler::assemble_texture_bundle;
use crate::encode::glb_parser::{parse_dep_uris, resolve_uri, GltfFlavor, GltfParseError};
use crate::encode::texture_writer::decode_to_texture2d;
use crate::encode::type_tree_db::TypeTreeDb;
use crate::errors::EncoderError;
use crate::types::{BuildTarget, ShaderManifest, ShaderType};

// ---------------------------------------------------------------------------
// Public data — the shapes that cross the napi-rs boundary.
// Field names use camelCase via `#[serde(rename_all)]` to match the TS surface
// without needing per-field annotations.
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SceneInput {
    pub entity_id: String,
    pub shader_type: ShaderType,
    pub catalyst_base_url: String,
    pub content_map: Vec<ContentEntry>,
    pub deps_digest_by_hash: HashMap<String, String>,
    pub cached_hashes: Vec<String>,
    pub skipped_hashes: Vec<String>,
    pub failure_tolerance: f64,
}

#[derive(Debug, Deserialize)]
pub struct ContentEntry {
    pub file: String,
    pub hash: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SceneOutput {
    pub bundles: Vec<Bundle>,
    pub partial_failures: Vec<PartialFailure>,
    pub stats: EncodeStats,
    pub logs: Vec<LogEntry>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Bundle {
    pub source_hash: String,
    pub bundle_name: String,
    /// Inline metadata.json TextAsset embedded inside the bundle. Returned
    /// alongside so consumer-server can use it for the per-asset cache
    /// write-through without re-parsing the bundle bytes.
    pub dependencies: Vec<String>,
    /// Uncompressed UnityFS bytes. consumer-server brotli-wraps + uploads.
    pub uncompressed_bytes: Vec<u8>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PartialFailure {
    pub hash: String,
    pub reason: String,
    pub message: String,
}

#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EncodeStats {
    pub total_gltf: u32,
    pub encoded_gltf: u32,
    pub total_textures: u32,
    pub encoded_textures: u32,
    pub cached_skipped: u32,
    pub broken_skipped: u32,
    pub encode_wall_ms: u64,
}

#[derive(Debug, Serialize)]
pub struct LogEntry {
    pub level: String,
    pub message: String,
}

// ---------------------------------------------------------------------------
// Asset classification — by extension, mirrors the TS-side classifier in
// gltf-deps.ts and the Unity-side categorisation in
// AssetBundleConverter.cs:1117-1119 (gltfExtensions / bufferExtensions /
// textureExtensions).
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum AssetKind {
    Glb,
    Gltf,
    Bin,
    Texture,
}

fn classify(filename: &str) -> Option<AssetKind> {
    let lower = filename.to_ascii_lowercase();
    if lower.ends_with(".glb") {
        Some(AssetKind::Glb)
    } else if lower.ends_with(".gltf") {
        Some(AssetKind::Gltf)
    } else if lower.ends_with(".bin") {
        Some(AssetKind::Bin)
    } else if lower.ends_with(".png") || lower.ends_with(".jpg") || lower.ends_with(".jpeg") {
        Some(AssetKind::Texture)
    } else {
        None
    }
}

// ---------------------------------------------------------------------------
// Encoder state. `Arc` so napi-rs can hold a `&self` and we can clone the
// inner state into a tokio task without lifetime constraints.
// ---------------------------------------------------------------------------

pub struct SceneEncoderInner {
    pub build_target: BuildTarget,
    pub ab_version: String,
    pub shader_manifest: ShaderManifest,
    /// Parsed TypeTree fixture loaded once at construction. Per-class
    /// writers (`texture_writer`, eventually `mesh_writer` /
    /// `material_writer`) look up their class's TypeTree from here at
    /// encode time.
    pub type_tree_db: Arc<TypeTreeDb>,
    /// Process-global cap on in-flight requests across all encode() calls.
    /// Tunable via `ENCODER_FETCH_CONCURRENCY`.
    pub fetch_semaphore: Arc<Semaphore>,
    /// Per-scene fetch parallelism (analogue of Unity's `downloadBatchSize`).
    pub per_scene_fetch_concurrency: usize,
}

impl SceneEncoderInner {
    /// Top-level entry point. Layout:
    /// 1. Filter the content list by `cachedHashes` / `skippedHashes` (mirrors
    ///    ResolveAssets in AssetBundleConverter.cs:1147-1174).
    /// 2. Fetch all remaining glbs concurrently — bounded by both the
    ///    process-global and per-scene semaphores.
    /// 3. For each glb, parse its URI references to identify dep textures
    ///    and buffers; fetch those that haven't been pulled already.
    /// 4. Encode each glb / texture into a UnityFS bundle (STUB).
    /// 5. Apply failure tolerance — if encoded/total falls below threshold,
    ///    return an Internal error so the TS side can fall back to Unity.
    pub async fn encode(self: Arc<Self>, input: SceneInput) -> Result<SceneOutput, EncoderError> {
        let start = std::time::Instant::now();
        let mut logs: Vec<LogEntry> = Vec::new();
        let mut partial_failures: Vec<PartialFailure> = Vec::new();
        let mut stats = EncodeStats::default();

        let cached: HashSet<&str> = input.cached_hashes.iter().map(|s| s.as_str()).collect();
        let skipped: HashSet<&str> = input.skipped_hashes.iter().map(|s| s.as_str()).collect();

        // ---- Step 1: classify + filter ---------------------------------
        let mut glb_assets: Vec<(String, String)> = Vec::new(); // (hash, filename)
        let mut texture_assets: Vec<(String, String)> = Vec::new();
        let mut buffer_assets: Vec<(String, String)> = Vec::new();

        for entry in &input.content_map {
            // Skip directive applies first — mirrors Unity-side ordering
            // at AssetBundleConverter.cs:1133-1135 ("a hash in both lists is
            // treated as skipped").
            if skipped.contains(entry.hash.as_str()) {
                stats.broken_skipped += 1;
                continue;
            }
            match classify(&entry.file) {
                Some(AssetKind::Glb) | Some(AssetKind::Gltf) => {
                    stats.total_gltf += 1;
                    if cached.contains(entry.hash.as_str()) {
                        stats.cached_skipped += 1;
                        continue;
                    }
                    glb_assets.push((entry.hash.clone(), entry.file.clone()));
                }
                Some(AssetKind::Bin) => {
                    // Buffers are leaves in Unity's pipeline (see the
                    // `.bin` early-continue in MarkAllAssetBundles at
                    // AssetBundleConverter.cs:940). They get fetched by
                    // referrer glbs, never independently. Track for stats
                    // only.
                    if !cached.contains(entry.hash.as_str()) {
                        buffer_assets.push((entry.hash.clone(), entry.file.clone()));
                    }
                }
                Some(AssetKind::Texture) => {
                    stats.total_textures += 1;
                    texture_assets.push((entry.hash.clone(), entry.file.clone()));
                }
                None => {
                    // Filenames the converter doesn't classify (scene.json,
                    // main.crdt, etc.) stay entity-scoped and are
                    // uploaded separately by consumer-server. Encoder
                    // doesn't touch them.
                }
            }
        }

        logs.push(LogEntry {
            level: "info".into(),
            message: format!(
                "entity={} target={:?} glbs={} textures={} buffers={} cached_skipped={} broken_skipped={}",
                input.entity_id,
                self.build_target,
                glb_assets.len(),
                texture_assets.len(),
                buffer_assets.len(),
                stats.cached_skipped,
                stats.broken_skipped,
            ),
        });

        // ---- Step 2: build a CatalystClient bound to this scene's base URL.
        // The reqwest::Client inside is internally pooled, so creating one
        // per encode() is cheap (handshake/conn reuse is per-host). Sharing
        // a single `reqwest::Client` across CatalystClients (one per scene)
        // is a v2 optimization — the pool would survive across encode calls.
        let catalyst = CatalystClient::new(input.catalyst_base_url.clone());

        // ---- Step 3: fetch glb bytes concurrently, capped ----
        let fetched_glbs = self.clone().fetch_many(&catalyst, &glb_assets, true).await;
        let mut glb_bytes: HashMap<String, Bytes> = HashMap::new();
        for (hash, result) in fetched_glbs {
            match result {
                Ok(bytes) => {
                    glb_bytes.insert(hash, bytes);
                }
                Err(err) => {
                    partial_failures.push(PartialFailure {
                        hash,
                        reason: "fetch_failed".into(),
                        message: err.to_string(),
                    });
                }
            }
        }

        // ---- Step 3b: build the per-glb dependency graph.
        //
        // For each fetched glb, parse its embedded glTF JSON and resolve
        // every `images[].uri` / `buffers[].uri` against the entity
        // contentMap. The resulting `dep_cids_by_glb` map drives the
        // `metadata.json` TextAsset that the UnityFS writer embeds into
        // each glb bundle — same dep list shape the Unity converter
        // emits (`AssetBundleMetadataBuilder.cs:42` produces the same
        // thing from Unity's AssetDatabase).
        //
        // glbs whose JSON is unparseable land in partial_failures with
        // reason "unparseable_glb". Matches the digester's behaviour at
        // asset-reuse.ts for the `unparseable` skip reason — keeps the
        // contract uniform across the two pre-Unity passes.
        let content_file_to_hash: HashMap<&str, &str> = input
            .content_map
            .iter()
            .map(|c| (c.file.as_str(), c.hash.as_str()))
            .collect();
        let mut dep_cids_by_glb: HashMap<String, Vec<String>> = HashMap::new();
        for (hash, filename) in &glb_assets {
            let Some(bytes) = glb_bytes.get(hash) else {
                continue;
            };
            let flavor = if filename.to_ascii_lowercase().ends_with(".glb") {
                GltfFlavor::Glb
            } else {
                GltfFlavor::Gltf
            };
            match extract_dep_cids(bytes, flavor, filename, &content_file_to_hash) {
                Ok(deps) => {
                    dep_cids_by_glb.insert(hash.clone(), deps);
                }
                Err(reason) => {
                    partial_failures.push(PartialFailure {
                        hash: hash.clone(),
                        reason: "unparseable_glb".into(),
                        message: reason,
                    });
                    // Remove the glb bytes so the encode step skips it
                    // rather than tripping again.
                    glb_bytes.remove(hash);
                }
            }
        }

        // ---- Step 4: fetch textures concurrently. We fetch every
        // not-cached texture; the encoder can't know which glbs reference
        // which without parsing glbs first, but for the production case
        // (entity content map is already trimmed by the catalyst) the
        // over-fetch is negligible.
        let fetched_textures = self
            .clone()
            .fetch_many(&catalyst, &texture_assets, false)
            .await;
        let mut texture_bytes: HashMap<String, Bytes> = HashMap::new();
        for (hash, result) in fetched_textures {
            match result {
                Ok(bytes) => {
                    texture_bytes.insert(hash, bytes);
                }
                Err(err) => {
                    partial_failures.push(PartialFailure {
                        hash,
                        reason: "fetch_failed".into(),
                        message: err.to_string(),
                    });
                }
            }
        }

        // ---- Step 5: encode each glb and texture into a UnityFS bundle.
        // This is the part that's intentionally not implemented in v1.
        let mut bundles: Vec<Bundle> = Vec::new();

        for (hash, filename) in &glb_assets {
            let Some(bytes) = glb_bytes.get(hash) else {
                continue; // already in partial_failures (fetch or parse)
            };
            let digest = input.deps_digest_by_hash.get(hash).cloned().ok_or_else(|| {
                EncoderError::MissingDepsDigest { hash: hash.clone() }
            })?;
            // Dep CIDs were computed in step 3b. Always present here because
            // a failing parse already removed the glb from glb_bytes.
            let dep_cids = dep_cids_by_glb
                .get(hash)
                .cloned()
                .unwrap_or_default();
            match encode_glb_bundle(
                &self.type_tree_db,
                self.build_target,
                hash,
                filename,
                bytes,
                &digest,
                &dep_cids,
            ) {
                Ok(bundle) => {
                    bundles.push(bundle);
                    stats.encoded_gltf += 1;
                }
                Err(EncodeAssetError::PartialFailure { reason, message }) => {
                    partial_failures.push(PartialFailure {
                        hash: hash.clone(),
                        reason,
                        message,
                    });
                }
                Err(EncodeAssetError::Fatal(err)) => return Err(err),
            }
        }

        for (hash, filename) in &texture_assets {
            let Some(bytes) = texture_bytes.get(hash) else {
                continue;
            };
            match encode_texture_bundle(
                self.build_target,
                &self.type_tree_db,
                &input.entity_id,
                hash,
                filename,
                bytes,
            ) {
                Ok(bundle) => {
                    bundles.push(bundle);
                    stats.encoded_textures += 1;
                }
                Err(EncodeAssetError::PartialFailure { reason, message }) => {
                    partial_failures.push(PartialFailure {
                        hash: hash.clone(),
                        reason,
                        message,
                    });
                }
                Err(EncodeAssetError::Fatal(err)) => return Err(err),
            }
        }

        // ---- Step 6: failure tolerance gate ----
        // Mirrors Unity's `failingConversionTolerance` check at
        // AssetBundleConverter.cs:210-228. If we exceeded the allowed
        // budget, surface as an Internal error so the TS-side scene-converter
        // can fall back to Unity (when ENCODER_FALLBACK_TO_UNITY=true).
        let total = stats.total_gltf + stats.total_textures;
        let encoded = stats.encoded_gltf + stats.encoded_textures;
        if total > 0 {
            let failed = total - encoded - stats.cached_skipped - stats.broken_skipped;
            let tolerated = (input.failure_tolerance * total as f64).round() as u32;
            if failed > tolerated {
                return Err(EncoderError::Internal(format!(
                    "{failed} asset(s) failed to encode out of {total} (tolerated {tolerated})"
                )));
            }
        }

        stats.encode_wall_ms = start.elapsed().as_millis() as u64;

        Ok(SceneOutput {
            bundles,
            partial_failures,
            stats,
            logs,
        })
    }

    /// Fetch a batch of assets concurrently, bounded by both the
    /// process-global semaphore (`fetch_semaphore`, set via
    /// `ENCODER_FETCH_CONCURRENCY`) and the per-scene concurrency cap
    /// (analogue of Unity's `downloadBatchSize`).
    async fn fetch_many(
        self: Arc<Self>,
        catalyst: &CatalystClient,
        assets: &[(String, String)],
        is_glb: bool,
    ) -> Vec<(String, Result<Bytes, FetchError>)> {
        use futures_util::stream::{FuturesUnordered, StreamExt};

        let mut fut_stream = FuturesUnordered::new();
        // Per-scene cap; the process-global semaphore is acquired inside
        // each spawned future.
        let scene_sem = Arc::new(Semaphore::new(self.per_scene_fetch_concurrency));

        for (hash, _filename) in assets {
            let hash = hash.clone();
            let catalyst = catalyst.clone();
            let scene_sem = scene_sem.clone();
            let global_sem = self.fetch_semaphore.clone();
            fut_stream.push(async move {
                let _scene_permit = scene_sem.acquire_owned().await.expect("scene_sem alive");
                let _global_permit = global_sem.acquire_owned().await.expect("global_sem alive");
                let result = catalyst.fetch_asset(&hash, is_glb).await;
                (hash, result)
            });
        }

        let mut out = Vec::with_capacity(assets.len());
        while let Some(item) = fut_stream.next().await {
            out.push(item);
        }
        out
    }
}

// ---------------------------------------------------------------------------
// Per-asset encoding errors. Distinct from EncoderError to enforce the
// "per-asset failures are data, encoder-wide failures are exceptions"
// contract documented in errors.rs.
// ---------------------------------------------------------------------------

enum EncodeAssetError {
    /// Logged into SceneOutput.partial_failures; scene proceeds.
    PartialFailure { reason: String, message: String },
    /// Aborts the whole encode and propagates to the TS side.
    Fatal(EncoderError),
}

// ===========================================================================
// STUBS — these are the points where genuine multi-month work begins.
//
// I'm deliberately not faking these. The right next move is the
// "phase 0 spike" from the architecture discussion: pick one Windows-target
// texture, decompile its existing UnityFS bundle with UnityPy, and replace
// THIS function with a real implementation that produces a byte-loadable
// equivalent. Then iterate to add glb support, then Mac/WebGL.
// ===========================================================================

/// DCL/Scene shader-bundle CAB path the Material's `m_Shader` external
/// resolves against (the Explorer's StreamingAssets shader bundle). The
/// Windows value is verified constant across v49 bundles; mac/webgl ship a
/// different shader bundle and need their own extracted CAB.
fn shader_cab_path(target: BuildTarget) -> Option<&'static str> {
    match target {
        BuildTarget::Windows => {
            Some("archive:/CAB-51fbd4c9d0fb3e603fd599ac9f5d01e1/CAB-51fbd4c9d0fb3e603fd599ac9f5d01e1")
        }
        _ => None,
    }
}

/// Encode a glb into a loadable UnityFS bundle.
///
/// Phase 1 scope (end-to-end, parse-back-validated): single visible mesh,
/// single primitive, single material, no texture. The mesh geometry and the
/// material properties are byte-validated against production (see
/// `gltf_mesh` / `gltf_material`); the assembled component graph is
/// structurally self-consistent (it parses back) but uses encoder-local
/// path-IDs, so it isn't byte-identical to Unity's output and its rendering
/// is confirmed only by the Explorer-load spike.
///
/// The richer graph — root + per-primitive child GameObjects, the
/// MeshRenderer/MeshCollider split for `_collider` meshes, and in-bundle
/// Texture2D + material texture PPtr wiring — is the next phase. Glbs that
/// need it return a `PartialFailure` so the scene still proceeds (and, with
/// `ENCODER_FALLBACK_TO_UNITY`, Unity converts them).
fn encode_glb_bundle(
    type_tree_db: &TypeTreeDb,
    build_target: BuildTarget,
    hash: &str,
    filename: &str,
    glb_bytes: &Bytes,
    digest: &str,
    dep_cids: &[String],
) -> Result<Bundle, EncodeAssetError> {
    use crate::encode::bundle_assembler::{assemble_glb_graph, GlbGraphInput};
    use crate::encode::gltf_material::{convert_glb_material, MaterialTextures};
    use crate::encode::gltf_mesh::convert_glb_scene;

    let partial = |reason: &str, message: String| EncodeAssetError::PartialFailure {
        reason: reason.to_string(),
        message,
    };

    let scene = convert_glb_scene(glb_bytes)
        .map_err(|e| partial("glb_scene_convert", format!("{filename}: {e}")))?;
    if scene.total_primitives == 0 {
        return Err(partial("glb_no_meshes", format!("{filename}: no mesh primitives to encode")));
    }

    let cab = shader_cab_path(build_target).ok_or_else(|| {
        partial("glb_shader_cab_missing", format!("no shader CAB path for {build_target:?} (Windows-only so far)"))
    })?;

    // Convert all glTF materials (indexed by glTF material index).
    let jlen = u32::from_le_bytes(glb_bytes[12..16].try_into().unwrap()) as usize;
    let j: serde_json::Value = serde_json::from_slice(&glb_bytes[20..20 + jlen])
        .map_err(|e| partial("glb_json", format!("{filename}: {e}")))?;
    let materials: Vec<_> = j["materials"]
        .as_array()
        .map(|a| (0..a.len()).map(|i| convert_glb_material(&j, i, &MaterialTextures::default())).collect())
        .unwrap_or_default();

    let suffix = build_target.filename_suffix();
    let bundle_name = format!("{hash}_{digest}{suffix}");

    let unityfs_bytes = assemble_glb_graph(
        type_tree_db,
        build_target,
        &type_tree_db.unity_version,
        &GlbGraphInput {
            bundle_name: &bundle_name,
            root_name: hash,
            content_filename: filename,
            scene: &scene,
            materials: &materials,
            shader_cab_path: cab,
            dependencies: dep_cids,
            metadata_timestamp: 0,
        },
    )
    .map_err(|e| EncodeAssetError::Fatal(EncoderError::Internal(format!("assemble_glb_graph {hash}: {e}"))))?;

    Ok(Bundle {
        source_hash: hash.to_string(),
        bundle_name,
        dependencies: dep_cids.to_vec(),
        uncompressed_bytes: unityfs_bytes,
    })
}

fn encode_texture_bundle(
    build_target: BuildTarget,
    type_tree_db: &TypeTreeDb,
    _entity_id: &str,
    hash: &str,
    filename: &str,
    texture_bytes: &Bytes,
) -> Result<Bundle, EncodeAssetError> {
    // Decode failures are per-asset (a broken PNG shouldn't fail the
    // scene) — surface as a PartialFailure. Everything downstream is a
    // genuine encoder bug (Fatal).
    //
    // The assembler produces a COMPLETE bundle: Texture2D (RGBA32,
    // uncompressed for phase 1) + the metadata.json TextAsset + the
    // AssetBundle root whose m_Container maps the asset path to the
    // texture. This matches the 3-object shape real Unity texture
    // bundles use (verified via dump-fields). Path/digest naming uses
    // the canonical leaf form `{hash}{platform_suffix}` (textures carry
    // no deps digest).
    //
    // Validate decodability first so a bad PNG is a partial failure.
    decode_to_texture2d(hash, texture_bytes).map_err(|e| EncodeAssetError::PartialFailure {
        reason: "texture_decode".into(),
        message: format!("{filename}: {e}"),
    })?;

    let suffix = build_target.filename_suffix();
    let bundle_name = format!("{hash}{suffix}");
    let content_filename = filename; // original content path key for m_Container

    let unityfs_bytes = assemble_texture_bundle(
        type_tree_db,
        build_target,
        &type_tree_db.unity_version,
        &bundle_name,
        content_filename,
        texture_bytes,
        // Deterministic timestamp: the encoder doesn't stamp a wall
        // clock (would make bundle bytes non-reproducible). 0 is fine —
        // the Explorer doesn't read the metadata timestamp for textures.
        0,
    )
    .map_err(|e| {
        EncodeAssetError::Fatal(EncoderError::Internal(format!(
            "assemble_texture_bundle failed for {hash}: {e}"
        )))
    })?;

    Ok(Bundle {
        source_hash: hash.to_string(),
        bundle_name,
        dependencies: Vec::new(), // textures are leaves
        uncompressed_bytes: unityfs_bytes,
    })
}

/// Walk a glb's `images[].uri` + `buffers[].uri` references, resolve each
/// against the entity contentMap, and return the deduplicated, sorted
/// list of dep CIDs. The result drives the bundle's `metadata.json`
/// TextAsset dependency list (the Explorer's loader reads this to
/// recursively fetch sibling bundles).
///
/// Skipping rules (matches the digester at gltf-deps.ts:106-113):
///   * `data:` URIs → skipped (inline base64, not external)
///   * embedded buffers (no uri field) → skipped
///   * URIs not present in contentMap → returned as an Err — Unity
///     wouldn't resolve them either, and the digester would have
///     already excluded this glb via the skipped-hashes path. If we
///     hit one here, the digester and encoder are seeing different
///     content lists and that's worth a partial_failure.
fn extract_dep_cids(
    bytes: &[u8],
    flavor: GltfFlavor,
    glb_filename: &str,
    content_file_to_hash: &HashMap<&str, &str>,
) -> Result<Vec<String>, String> {
    let uris = match parse_dep_uris(bytes, flavor) {
        Ok(u) => u,
        Err(GltfParseError::Json(msg)) | Err(GltfParseError::Structural(msg)) => {
            return Err(msg);
        }
        Err(GltfParseError::Uri { uri, reason }) => {
            return Err(format!("glTF URI \"{uri}\": {reason}"));
        }
    };

    let mut deps: std::collections::BTreeSet<String> = std::collections::BTreeSet::new();
    for uri in uris {
        let resolved = resolve_uri(&uri, glb_filename)
            .map_err(|e| format!("URI resolve failed: {e}"))?;
        match content_file_to_hash.get(resolved.as_str()) {
            Some(cid) => {
                deps.insert((*cid).to_string());
            }
            None => {
                // contentMap mismatch — see fn doc.
                return Err(format!(
                    "glTF URI \"{uri}\" resolves to \"{resolved}\" which is not in the entity contentMap"
                ));
            }
        }
    }
    Ok(deps.into_iter().collect())
}

#[allow(dead_code)]
fn serialize_unityfs_container() {
    // ---------- TODO (phase 1: UnityFS encoder) --------------------------
    // The UnityFS container is the binary envelope around the serialised
    // objects produced by encode_glb_bundle / encode_texture_bundle.
    //
    // Layout (reverse-engineered from AssetRipper / UnityPy):
    // 1. Header: signature ("UnityFS"), format version (6 for 2021.x),
    //    Unity version string ("2021.3.20f1"), file size (8 bytes BE),
    //    compressed/uncompressed block-info sizes, flags.
    // 2. BlockInfoAndDirectory: LZ4-compressed table of
    //    (uncompressed-size, compressed-size, flags) per chunk, plus
    //    the asset directory (path, offset, size, flags per object).
    // 3. Data blocks: chunked LZ4 of the serialised file payload.
    //
    // Required external libs:
    // - lz4_flex for ChunkBasedCompression (matches Unity's LZ4 implementation)
    // - byteorder for the BE/LE field writes (UnityFS mixes both)
    //
    // Verify against a Unity-built fixture during phase 0 — produce a
    // byte-equivalent (modulo timestamps) bundle from the same input.
    // --------------------------------------------------------------------
}
