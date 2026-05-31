# CLAUDE.md

Operational and development context for agents working in this repo. For deeper architectural background, read `docs/ai-agent-context.md` and `README.md` first. This file assumes you've read those.

## What this repo is

Two-part system that turns Decentraland scene content (GLTFs, textures, buffers) into Unity asset bundles served from a CDN.

- **`consumer-server/`** — Node.js / TypeScript service. HTTP + SQS worker. Orchestrates conversions and uploads to S3. Tests live here.
- **`asset-bundle-converter/`** — Unity project (Unity 2021.3.20f1). C# editor scripts that do the actual GLTF → AssetBundle conversion. Invoked by the consumer-server via `child_process.spawn`.

Everything else at the repo root (`Dockerfile`, `convert-*.sh`, `ci-*.sh`) is CI / deploy glue.

## Common commands

Run from `consumer-server/` unless otherwise noted.

```bash
yarn install                 # first time
yarn build                   # tsc -p tsconfig.json
yarn test                    # jest --coverage, forceExit, detectOpenHandles
yarn lint:check              # eslint
yarn lint:fix                # eslint --fix (prettier runs via eslint-plugin-prettier)

# Standalone runnables (after `yarn build`):
yarn test-conversion         # Runs a real Unity conversion locally. Requires UNITY_PATH + PROJECT_PATH + BUILD_TARGET env + a valid Unity license.
yarn migrate                 # Backfills old entity-scoped bundles into the canonical prefix. Fetches each glb's bytes from the catalyst per entity to compute the per-glb digest (heavier on catalyst than the original entity-wide-digest form — rate-limit-aware). See consumer-server/src/migrate-to-canonical.ts for flags.
```

Local Docker:

```bash
docker build -t ab-converter .        # from repo root
docker run -p 5001:5000 ab-converter  # curl localhost:5001/metrics to verify
```

## Key concepts and vocabulary

- **`AB_VERSION` / `AB_VERSION_WINDOWS` / `AB_VERSION_MAC`** — converter version per build target. Bundle paths are version-scoped (`v48/...`). Bumping invalidates old bundles; don't bump casually.
- **`BUILD_TARGET`** — `webgl` | `windows` | `mac`. One value per worker pool. The pool ships a Unity build targeting that platform.
- **Content hash / CID** — IPFS-style identifier for a scene asset (GLTF, PNG, BIN). Unity emits bundle filenames as `{hash}_{target}` (plus `.br` for brotli and `.manifest` for Unity's per-bundle manifest).
- **Entity** — a scene / wearable / emote. Identified by `entityId` (itself a CID). An entity's `content` is a list of `{file, hash}` pairs fetched from a Decentraland catalyst (`{contentServerUrl}/entities/active`).
- **Top-level entity manifest** — `manifest/{entityId}[_{target}].json`. Lists bundle filenames that were produced for this entity and the `AB_VERSION` they were produced with. Clients fetch this first to discover what's been converted. Uploaded with `Cache-Control: private, max-age=0, no-cache` — **do not override this**.

## Bundle URL scheme (as of PR #258 + per-glb digest)

Two upload paths exist simultaneously:

```
{AB_VERSION}/assets/{hash}_{depsDigest}_{target}   # canonical glb/gltf, keyed by per-asset dep digest
{AB_VERSION}/assets/{hash}_{target}                # canonical bin/texture (leaves, no digest)
{AB_VERSION}/{entityId}/{hash}_{target}            # entity-scoped — legacy path, still used when ASSET_REUSE_ENABLED=false
```

`depsDigest` is computed per-glb/gltf from the specific `images[].uri` + `buffers[].uri` it references (resolved against the entity's `content` map). Two scenes sharing a glb CID AND the exact set of referenced deps land at the same canonical path; any difference in the referenced deps produces a distinct path. BINs and textures are leaves — their bundle output doesn't reference siblings, so they stay hash-only.

Per-scene source files stay entity-scoped (genuinely per-scene):

```
{AB_VERSION}/{entityId}/main.crdt
{AB_VERSION}/{entityId}/scene.json
{AB_VERSION}/{entityId}/index.js
```

Client-visible URL scheme is unchanged — clients still fetch `{AB_VERSION}/{entityId}/{filename}`. The `ab-cdn-rewriter` Cloudflare Worker (in `dcl/cloudflare-workers`) rewrites to canonical with a fallback to the entity-scoped path.

## Kill-switch

`ASSET_REUSE_ENABLED` (default `true`, case-insensitive — `false` / `0` / `no` / `off` all disable). Gates the per-asset reuse path in `consumer-server/src/logic/conversion-task.ts`. When off, everything falls back to the legacy entity-scoped upload.

## Testing standards

**Always follow the `dcl-testing` skill** when writing or modifying `*.spec.ts` / `*.test.ts`:

- `describe` uses contextual `when ...` / `and ...` phrasing (NOT feature-group names).
- `it('should ...')` descriptions are specific (`'should respond with 500 and the error message'` rather than `'should fail'`).
- Input data, mocks, and the subject-under-test invocation live in `beforeEach` at describe scope — NOT inside `it()` blocks.
- Each `describe` with mocks has its own `afterEach(() => jest.clearAllMocks())`.
- One assertion per `it()` unless they verify one invariant (e.g. two requests sharing the same cache key).

Examples of correctly-styled tests to follow:
- `consumer-server/test/unit/asset-reuse.spec.ts`
- `consumer-server/test/integration/execute-conversion.spec.ts`

Mock storage in tests: `mock-aws-s3` (already a dependency). `components.ts` in `test/` builds a runner that returns a `TestComponents` object; integration tests use that.

## Code conventions

- **TypeScript strict mode.** No `any` unless interacting with truly dynamic shapes (AWS SDK, jest mocks).
- **well-known-components pattern.** Components (config, logs, metrics, cdnS3, sentry, …) are passed via an `AppComponents` type. Functions take `Pick<AppComponents, 'logs' | 'cdnS3' | …>` so their dependencies are explicit. Don't reach for a global — require what you need.
- **Prettier** (configured in `consumer-server/package.json`): `printWidth: 120`, `semi: false`. Run `yarn lint:fix` before committing.
- **Metrics naming**: `ab_converter_{noun}_{verb|state}` e.g. `ab_converter_exit_codes`, `ab_converter_asset_cache_hits_total`. Labels: `build_target`, `ab_version` where relevant.
- **Comments**: only for non-obvious *why*. Don't narrate the *what*.

## Cross-repo touch-points

This service doesn't live in isolation. Changes here often imply changes in one of these repos:

- **`dcl/ab-cdn`** — Pulumi project that owns the `ab-cdn.decentraland.*` S3 bucket, CloudFront distribution, CORS rules, and Cloudflare DNS record. If something feels off about the origin serving asset bundles, the infra config is there. The bucket's `contentBucket` and CloudFront's `cloudFrontDomain` are exposed as Pulumi stack outputs.
- **`dcl/cloudflare-workers`** — hosts the `ab-cdn-rewriter` Worker (`workers/ab-cdn-rewriter/`) that does canonical-first routing at the Cloudflare edge. Fetches via `dXXX.cloudfront.net` from the `ab-cdn` stack (pulled via `StackReference`). Companion to PR #258 here.
- **Decentraland Explorer** (client) — fetches manifests and bundles from `ab-cdn.decentraland.*`. See the resolver pseudocode in `README.md`. URL scheme is stable; changes to it need cross-team coordination.
- **deployments-to-sqs** — publishes the SNS events this service consumes from the SQS queue. `AssetBundleConversionFinishedEvent` is published back when we're done.

## Known gotchas

- **`shouldIgnoreConversion` has a pre-existing argument-order bug** (`conversion-task.ts:110-132`). The function takes `($AB_VERSION, entityId, target)` but the caller at line ~295 passes `(entityId, abVersion, target)` — swapped. The fast path has been dead code for a while. Fixing it silently changes production skip behavior, so handle in a dedicated PR with explicit review.
- **Don't override `Cache-Control` on `manifest/*.json`**. The converter uploads with `private, max-age=0, no-cache` deliberately so clients revalidate after each conversion. Overriding anywhere (worker, Page Rule, converter) means clients stop seeing new scene hashes.
- **Don't bump `AB_VERSION` casually.** Invalidates every existing canonical and entity-scoped bundle at that version. Full re-conversion of active scenes required. Ops-level decision.
- **`hasContentChange` is legacy and narrow** (`has-content-changed-task.ts`). Non-WebGL, scenes only, immediate-previous-version only, all-or-nothing. Superseded by per-asset reuse — kept only as fallback when `ASSET_REUSE_ENABLED=false`. Plan to delete once new path proves.
- **Unity spawns are minutes long.** Short-circuit wherever possible via the per-asset cache probe (`checkAssetCache` in `src/logic/asset-reuse.ts`) before calling `runConversion`.
- **Content hashes are CIDs** — no slashes, no special chars. The bundle-filename regex `[^/]+_(?:webgl|windows|mac)(\.br|\.manifest|\.manifest\.br)?` assumes that shape.
- **`mock-aws-s3` is used when `CDN_BUCKET` is unset** (see `components.ts`). Tests rely on this. Don't require `CDN_BUCKET` at module-load time.

## Rollout / ops notes for PR #258 (still in flight at time of writing)

- Deploy **with `ASSET_REUSE_ENABLED=false`** first. Baseline.
- Flip to `true` **per build target pool** (Windows → Mac → WebGL). Each pool has one `BUILD_TARGET`, so flipping is per-pool.
- Run `yarn migrate --ab-version {v} --target {webgl|windows|mac}` (dry-run first) to backfill pre-PR entity-scoped bundles into canonical. The script computes per-glb digests by downloading each glb from the catalyst — noticeably heavier than the previous entity-wide-digest form, so expect longer wall-clock runs and be ready to throttle via `--concurrency` if the catalyst rate-limits. The run is idempotent: re-running after a failure only re-probes (HEAD) the already-canonical objects.
- Once the canonical prefix is fully populated, swap the Cloudflare Worker for a plain Transform Rule (follow-up MR in `dcl/cloudflare-workers`).
- Then `hasContentChange` can be deleted here.

## File references for quick navigation

- HTTP entry: `consumer-server/src/index.ts` → `main()` in `service.ts`.
- Scene conversion orchestration: `src/logic/conversion-task.ts` → `executeConversion` (~line 254).
- LoD conversion: `src/logic/conversion-task.ts` → `executeLODConversion`.
- Per-asset cache probe + LRU: `src/logic/asset-reuse.ts`.
- Backfill script: `src/migrate-to-canonical.ts`.
- Unity spawn: `src/logic/run-conversion.ts` → `runConversion`, `runLodsConversion`.
- Unity CLI entry for scenes: `asset-bundle-converter/Assets/AssetBundleConverter/SceneClient.cs` → `ExportSceneToAssetBundles`.
- Unity asset resolution / bundle build: `asset-bundle-converter/Assets/AssetBundleConverter/AssetBundleConverter.cs` → `ResolveAssets` (~line 1053).

## Changelog policy

Significant functional changes worth capturing here as they land:

- **2026-04 — PR #258**: per-asset reuse via canonical `{AB_VERSION}/assets/` path. `ASSET_REUSE_ENABLED` kill-switch. `yarn migrate` backfill script. Unity `-cachedHashes` CLI flag.
- **2026-04 — per-glb digest**: replaced the entity-wide `depsDigest` with a per-asset digest derived from each glb/gltf's actual URI references (`images[].uri` + `buffers[].uri`). Consumer-server now parses glb bytes server-side (`src/logic/gltf-deps.ts`) and passes Unity a `{hash → digest}` map via a temp JSON file (`-depsDigestsFile` CLI flag, replaces `-depsDigest`). Two scenes sharing a glb CID and its referenced textures now land at the same canonical path even when the rest of the scene differs, closing the cross-scene reuse gap that the entity-wide digest left open. **No `AB_VERSION` bump required** — the new filename `{hash}_{perGlbDigest}_{target}` is byte-distinct from the pre-change `{hash}_{entityWideDigest}_{target}`, so old manifests continue to resolve to their (still-present) old canonical bundles while new conversions upload to the new per-glb paths. The two populations coexist in `{AB_VERSION}/assets/` without collision; storage grows modestly as old paths become orphaned over time.
- **2026-04 — migrate-to-canonical ported to per-glb digest**: `yarn migrate` now computes the same per-glb digests the live converter produces (via `computePerAssetDigests` against the catalyst) instead of the entity-wide digest. Re-running the script no longer produces dead storage under the canonical prefix. Requires a reachable catalyst per-entity and one glb-bytes fetch per glb in each kept manifest — noticeably heavier than the original form. New `manifestsDigestFailed` stat distinguishes "catalyst served entity metadata but glb bytes failed to parse" from the existing "entity fetch failed" case. Also added: `Retry-After` honouring in the shared fetcher (parses delta-seconds + HTTP-date, capped at 30 s so a pathological catalyst can't park a worker past SQS visibility). Catalyst fetch from `executeConversion` now bounded at 30 s via the same timeout path.
- **2026-04 — per-glb skip for missing/unparseable deps**: scenes regularly carry glbs that reference URIs absent from the entity's `content` map, or whose bytes are structurally malformed (bad magic, truncated JSON chunk, percent-encoding that fails to decode). Pre-change those caused `computePerAssetDigests` to throw and fail the entire scene with exit code 5 + Sentry + `_failed.json` sentinel — even when the rest of the scene was convertible. `computePerAssetDigests` now returns `{ digests, skipped }`; broken glbs land in `skipped` (with reason `'missing-deps'` / `'unparseable'`) and the scene continues. New CLI flag `-skippedHashes` tells Unity to drop those hashes from `gltfPaths` / `bufferPaths` in `ResolveAssets` before any download or import attempt — same RemoveAll mechanism as `-cachedHashes`, distinct semantics (cached has a canonical bundle upstream; skipped has no bundle anywhere). New metric `ab_converter_glb_skipped_total{build_target,ab_version,reason}` plus a per-scene warn log carrying up to five sample skip records. Migration script's `glbSkippedDuringMigration` counter tracks skipped bundles dropped from canonical copy (distinct from `manifestsDigestFailed`, which now fires only on actual fetch/infra errors). Catalyst 5xx / network errors stay as throws — those are transient and SQS retry remains the right response. Scope: canonical path only (`useAssetReuse=true`); the legacy path already survives broken glbs via Unity's `UNCAUGHT FATAL` handler. **No `AB_VERSION` bump.**

- **2026-05 — Rust encoder scaffold (in progress)**: long-running effort to replace per-scene Unity spawns with a standalone Rust+napi-rs encoder that produces UnityFS-compatible bundles. Scaffolding committed; **scene encoder core is intentionally stubbed** (the UnityFS container, TypeTree-driven serialisation, mesh/material/texture writers are multi-month reverse-engineering work — not faked in this scaffold). What IS implemented and load-bearing:
  - `encoder/` Rust crate with napi-rs bindings (`createEncoder` / `encoder.encode`).
  - **`encoder/src/catalyst_client.rs` mirrors `consumer-server/src/logic/asset-reuse.ts:460-838` line-for-line.** Same constants (256 MiB body cap, 3 attempts, 250 ms base backoff, 30 s Retry-After cap), same status classification (408 / 429 / 5xx retryable), same `?_retry={attempt}` cachebust on retries, same truncation-as-retryable semantics. Bump on one side ⇒ bump on the other in the same PR (the four constants at the top of catalyst_client.rs carry a comment pointing here).
  - `consumer-server/src/adapters/asset-bundle-encoder/` — TS adapter wrapping the native module. `start()` loads bake artifacts from `s3://${AB_BAKE_BUCKET}/${BAKE_VERSION}/${BUILD_TARGET}/{typetrees.bin, shader-guids.json, bake-info.json}`. Failure fails pod start (no lazy retry).
  - `consumer-server/src/logic/scene-converter/` — logic component that routes between Unity and the encoder based on `ENCODER_ENABLED`. `conversion-task.ts:682` now calls `sceneConverter.convert()` instead of `unityRunner.runConversion()`. The encoder-only fields (`catalystBaseUrl`, `contentMap`, `shaderType`) are passed alongside the existing Unity fields; the Unity path ignores them.
  - **LOD conversion stays Unity-only.** `executeLODConversion` continues to call `unityRunner.runLodsConversion` directly — not routed through the scene-converter. Encoder doesn't implement LODs in v1.
  - **Shader resolution — CORRECTED (verified against real v49 bundles + the Explorer, 2026-05-29).** The earlier "name-based / `.meta` GUID" note was WRONG. A Unity Material's `m_Shader` is always a PPtr (`m_FileID` into the SerializedFile externals table + `m_PathID`); there is no shader-name string in the serialized Material. In real converter glb bundles the externals table entry is **not a `.meta` GUID** — it is an external *SerializedFile* reference by CAB path: `guid=0, type=0, path="archive:/CAB-<shaderbundle>/CAB-<shaderbundle>"`. Concretely, a v49 glb Material references `m_FileID=1 → externals[0] = archive:/CAB-51fbd4c9d0fb3e603fd599ac9f5d01e1/…`, `m_PathID=0x6a1984f5061ced9d`. That CAB is the Explorer's **StreamingAssets shader bundle** `Assets/StreamingAssets/AssetBundles/dcl/scene_ignore_<platform>`, built by the Explorer's `CompileSceneShader` editor tool (contains `Scene.shader` = DCL/Scene). The Explorer loads that shader bundle at app start; Unity resolves the glb Material's `archive:/CAB-…` external against it. **So the correct shader bake artifact is `{external CAB-path string, per-shader m_PathID}` extracted from a real converter bundle — NOT GUIDs from `.meta`.** `bake-encoder-artifacts.ts`'s `shader-guids.json` (GUID-based) is the wrong mechanism and must be replaced before the glb/Material builder is implemented. Our `SerializedFile` writer already supports externals with arbitrary path strings, and the round-trip-verified path reproduces them exactly — so this is implementable; only the bake artifact + `build_material_value` need to use the CAB-path form. Bundles' `metadata.json` dep lists still contain only scene-content CIDs (the shader bundle is a player-side StreamingAssets dependency, not a per-scene CDN dep) — matching `AssetBundleMetadataBuilder.cs:42`.
  - **`.manifest` sidecars are NOT emitted by the encoder.** Confirmed dead in production today: Unity's `CleanAssetBundleFolder` (`Utils.cs:557`) deletes them before upload, and the Explorer's loader never fetches `.manifest` URLs. The `**/*.manifest` match in `conversion-task.ts:748-752` matches zero files; left in place as a defensive no-op.

  Environment variables introduced:
  - `ENCODER_ENABLED` (bool, default `false`) — kill switch. Off everywhere by default.
  - `ENCODER_FALLBACK_TO_UNITY` (bool, default `true`) — when the encoder throws an `INTERNAL` error, retry the same scene via Unity. Misconfig codes (`TARGET_MISMATCH`, `INVALID_BAKE`, `NOT_STARTED`) skip fallback — Unity wouldn't help.
  - `BAKE_VERSION` (required when `ENCODER_ENABLED=true`) — pins which bake artifacts the pod loads.
  - `AB_BAKE_BUCKET` (required when `ENCODER_ENABLED=true`) — S3 bucket holding bake artifacts. Distinct from `CDN_BUCKET`.
  - `ENCODER_FETCH_CONCURRENCY` (optional, default 64) — process-global cap on parallel catalyst fetches across all `encode()` calls.
  - `ENCODER_PER_SCENE_FETCH_CONCURRENCY` (optional, default 16) — analogue of Unity's `downloadBatchSize`.

  New metrics: `ab_converter_engine_used_total{engine}`, `ab_converter_encoder_errors_total{build_target,code}`, `ab_converter_encoder_partial_failures_total{build_target,ab_version}`, `ab_converter_encoder_wall_seconds{build_target,ab_version}` (histogram).

  **Bake step is Unity-free.** Driver lives at `consumer-server/src/bake-encoder-artifacts.ts`, invoked via `yarn bake --explorer-repo <path> --bake-version <tag> --output <dir>`. No Unity install, no Unity license, no editor required — runs on any Linux/macOS box with Node.js. Unity's role at bake time is replaced by:
    - **Shader GUIDs**: parsed from the Explorer repo's `*.shader.meta` YAML files (`Explorer/Library/PackageCache/com.decentraland.unity-shared-dependencies@*/Runtime/Shaders/`). Unity wrote them once when the assets were first imported; they're git-tracked and stable.
    - **Shader names**: parsed from each `.shader`'s first `Shader "..."` line.
    - **Shader pathIDs**: hardcoded to Unity's `.shader` convention (`4_800_000`); override per-shader via the script's `SHADER_PATH_ID_OVERRIDES` map if a future shader doesn't follow it.
    - **TypeTrees**: vendored as a pre-extracted binary at `encoder/baked-fixtures/typetrees/<unity_version>.bin`. The vendored file comes from running the in-crate extractor against any existing ab-cdn bundle: `cd encoder && cargo run --bin extract-typetrees --no-default-features -- /path/to/source.assetbundle baked-fixtures/typetrees/2021.3.20f1.bin`. The extractor is itself Unity-free — it reads UnityFS + SerializedFile in Rust, no Python / .NET / Unity needed. Full procedure in `encoder/baked-fixtures/README.md`. Re-extract only on Unity-version upgrades. When the fixture is absent, the bake driver emits a 1-byte stub so pods can start; ENCODER_FALLBACK_TO_UNITY=true catches the resulting serialisation failures during rollout.

    Upload to S3 after baking: `aws s3 cp ./output-bake/ s3://${AB_BAKE_BUCKET}/${BAKE_VERSION}/ --recursive`. (The previous Unity editor script at `asset-bundle-converter/Assets/AssetBundleConverter/Editor/BakeArtifacts.cs` was deleted — the Unity-free path replaces it.)

  Rollout shape (per-target flag, matching `ASSET_REUSE_ENABLED`): deploy with `ENCODER_ENABLED=false`; flip on one Windows pod with `ENCODER_FALLBACK_TO_UNITY=true`; expand to the Windows pool, then Mac, then WebGL; once encoder reliability is steady per pool, flip `ENCODER_FALLBACK_TO_UNITY=false`; eventually remove the Unity runner adapter.

  **Binary writers — UnityFS container + SerializedFile structure (spec-derived, not Unity-verified)**:
  - `encoder/src/encode/unityfs_writer.rs` — UnityFS outer container. Header ("UnityFS\0", format version 6, unity revision, sizes, flags), BlockInfo+Directory section (LZ4-compressed), data blocks (LZ4 ChunkBasedCompression at 128 KiB chunks). Uses the `lz4_flex` crate's block API to match Unity's raw LZ4 wire format (not the .lz4 frame format).
  - `encoder/src/encode/serialized_file.rs` — SerializedFile container, format version 22 (Unity 2021.3). Mixed BE/LE byte order matching Unity's reader, 16-byte aligned object data section, externals table with GUID + type + path entries.
  - `encoder/src/encode/type_tree.rs` — TypeTree binary parser (reads the on-disk format Unity emits inside SerializedFile metadata, including Unity's common-strings table for the high-bit-flagged offsets) + alignment-aware `TypeTreeWriter` that walks tree nodes alongside a `Value` enum (Bool / I32 / F32 / String / Bytes / Array / Struct) and applies `ALIGN_BYTES` 4-byte padding rules.
  - All three writers come with self-verifying tests: 43 unit tests covering LZ4 round-trip, header parse-then-write, BlockInfo round-trip, struct alignment, string padding, array-container length prefixes, TypeTree blob round-trip with hand-built fixtures. **No external Unity bundle has been diffed yet**, so byte-correctness against Unity's loader is unverified. The structural pipeline is in place; per-class verification is the next phase.
  - `encoder/src/encode/unityfs.rs` `write_bundle` / `serialize_serialized_file` are no longer `NotImplemented` — they delegate to the writers above. The per-class object writers (`encode_glb_bundle` / `encode_texture_bundle` in `scene_encoder.rs`, the placeholders in `mesh.rs` / `material.rs` / `texture.rs`) still return `NotImplemented` because they need (a) the vendored TypeTree fixture at `encoder/baked-fixtures/typetrees/<unity_version>.bin` to drive field walks, and (b) a Unity-built reference bundle to verify byte correctness against.

  **`dump-object` general inspection binary** at `encoder/src/bin/dump-object.rs`. Takes `(bundle.assetbundle, class_id)` and prints the first object's bytes for that class. **Currently works on bundles whose object-entry layout matches what AssetRipper documents for SerializedFile format 22**: path_id i64 LE, byte_start i64 LE, byte_size u32 LE, type_index i32 LE — verified against the v36 texture bundle (`/tmp/source.assetbundle`). The v35 glb bundle (`/tmp/glb-bundle.assetbundle`) has the SAME unity_revision ("2022.3.12f1") but its object-table entries produce nonsensical byte_start values (~11 MiB into a 6 KiB data section), suggesting a different per-bundle SerializedFile sub-format. **Resolving this is the next iteration cycle blocker** for verifying Mesh / Material / GameObject / Transform / MeshFilter / MeshRenderer (those classes only appear in glb bundles, not texture bundles).

  Hypotheses to investigate next session:
  - Unity 2022.3 may emit different object-entry padding when path_id is hashed vs. sequential (texture bundle uses sequential path_ids; glb bundle uses hash-style).
  - PPtr format inside the bundle may have changed (i32 file_id → i64 file_id) — would explain the apparent 4-byte misalignment.
  - The bundle may have been built with a Unity setting (BuildAssetBundleOptions or platform-specific flag) that affects metadata layout independently of the SerializedFile version field.

  Recommended next investigation: download a glb bundle from a more recent v37+ deployment (likely matches the texture bundle's format) and diff its metadata against the v35 glb's.

  **Per-class writer verification (6 classes byte-equal against real bundles)**:
  - **Texture2D (class 28)** — structurally verified against v36 reference bundle (different inputs, identical field layout through `m_TextureFormat`).
  - **MeshFilter (class 33)** — byte-equal against v49 glb reference. 24-byte object = 2 PPtrs.
  - **Transform (class 4)** — byte-equal. 68 bytes (PPtr + rotation + position + scale + Array<children> + father PPtr).
  - **GameObject (class 1)** — byte-equal. 111 bytes (Array<ComponentPair> + layer + name + tag + active).
  - **AssetBundle (class 142)** — byte-equal. 640 bytes (11 root fields including m_Container as Array<pair<string, AssetInfo>> and m_PreloadTable).
  - **MeshRenderer (class 23)** — byte-equal. 168 bytes, 32 fields.

  **The "MeshRenderer quirk" was a wrong-fixture version mismatch, now solved.** Production v49 bundles are **Unity 6000.2.6f2**, but the verifiers were loading the **2022.3.12f1** TypeTree fixture. Unity 6 added 5 MeshRenderer fields (`m_RayTracingAccelStructBuildFlagsOverride`, `m_RayTracingAccelStructBuildFlags`, `m_SmallMeshCulling`, `m_ForceMeshLod`, `m_MeshLodSelectionBias`) — the missing fields caused a 12-byte cascade misalignment that *looked* like a 2-byte `m_Enabled` field. `m_Enabled` is in fact 1 byte (TypeTree `byte_size=1`, written via `Value::U8`); the writer dispatches on `byte_size` not the type-name string, so it was always correct. Fixes that landed:
    - Extracted a Unity 6 fixture: `encoder/baked-fixtures/typetrees/6000.2.6f2-glb.bin` (from the live v49 bundle). All verifiers now load this.
    - **New diagnostic `dump-fields`** (`encoder/src/bin/dump-fields.rs`): a generic TypeTree-driven *reader* that walks any class's TypeTree against the real object bytes, printing each field's offset/type/size/value and asserting the walk ends exactly at the object boundary. This made the misalignment visible in one run instead of hand-counting. The `is_array` flag is now preserved on `TypeTreeNode` (was discarded) so the reader/walker detect arrays authoritatively.
    - Per-class fixtures matter: a class's TypeTree can change between Unity versions. Always verify against a fixture extracted from the same AB_VERSION/Unity version as the target bundle.

  **Serialization layer proven byte-correct for ALL 8 classes via round-trip.** `encoder/src/bin/verify-roundtrip.rs` + `TypeTreeReader` (in `type_tree.rs`, the exact inverse of `TypeTreeWriter`): for each class in a real bundle it reads a `Value` from the object bytes, asserts the read consumed the whole object, writes the `Value` back, and requires byte-identity. Results against live production bundles:
    - v49 glb (Unity 6000.2.6f2), all 8 classes ✓ BYTE-EQUAL: Transform(68), **Material(1264)**, TextAsset(100), **Mesh(1824)**, MeshRenderer(168), AssetBundle(640), MeshFilter(24), GameObject(111).
    - v36 texture (Unity 2022.3.12f1): Texture2D(264), AssetBundle(348), TextAsset(100) ✓.
    - A 305 KB textured glb (Unity 6): Texture2D **1,398,300 bytes** ✓ — confirms large binary image payloads survive the round-trip intact (read as `Value::Bytes`, no UTF-8 corruption).

    Material and Mesh — the two biggest TypeTrees — are byte-correct without any hand-written per-class parser. The round-trip property (`write(read(bytes)) == bytes`) proves the `TypeTreeWriter` reproduces real Unity object bytes for arbitrary classes; the remaining encode-path work is the glTF→`Value` builders (`build_<class>_value`), a separate semantic concern from the now-verified binary serialization. A hand-built `reader_writer_round_trip_handbuilt` unit test pins the reader/writer inverse property in CI without needing live bundles.

    `TypeTreeReader` design notes (kept byte-exact with the writer): leaves read as unsigned-by-byte_size (U8/U16/U32/U64 — LE bytes are identical regardless of int/float interpretation); 1-byte-element arrays (strings AND TypelessData) read as `Value::Bytes` (raw, no UTF-8); wrapper-descent + ALIGN_BYTES mirror the writer's early-return path exactly.

  **Complete texture bundle assembly — done + wired + self-verifying.** `encode/bundle_assembler.rs::assemble_texture_bundle` produces the full 3-object bundle real Unity texture bundles use (verified shape via `dump-fields`): Texture2D + a `metadata.json` TextAsset (the dep list the Explorer reads) + the AssetBundle root whose `m_Container` maps the asset path to the texture. `scene_encoder::encode_texture_bundle` now calls it, so the encoder's texture path emits loadable 3-object bundles (was: a bare Texture2D). A unit test (`assembled_texture_bundle_parses_back`) confirms the emitted bytes parse back through our own UnityFS+SerializedFile reader with all three classes present. Textures are emitted RGBA32 (uncompressed) for phase 1 — bigger than Unity's BC7 output but the loader accepts the declared format; BC7/ASTC/ETC2 compression is a later optimisation. `TextAsset` (class 49) builder added (`build_text_asset_value`).

  **Unity 6 mesh vertex layout — fully reverse-engineered (grounded, not guessed).** Read directly from a real v49 DCL glb mesh: `m_IndexFormat=1` (UInt32 indices); 14 channel slots with 3 used — ch0 Position (stream 0, offset 0, format 0=Float32, dim 3), ch1 Normal (stream 0, offset 12, dim 3), ch4 UV0 (stream 1, offset 0, dim 2); two-stream packing (stream 0 = 24 B pos+normal interleaved for all verts, then stream 1 = 8 B uv for all verts), 32 B/vertex total. This de-risks the mesh geometry packer.

  **Corpus regression scripts + result.** `encoder/scripts/download-scenes.sh` sweeps the asset-bundle-registry parcel grid, finds scenes at a target AB_VERSION (default v48/v49), and downloads their bundles from ab-cdn into `<dir>/<version>/<entityId>/`. `encoder/scripts/verify-scenes.sh` builds `verify-roundtrip` (release) and runs it over every downloaded bundle, tallying byte-exact objects per class. Discovery is batched (hundreds of pointers per registry POST; `DISCOVER_ONLY=1` counts without downloading, `REUSE_DISCOVERY=1` skips the sweep on re-download).

  **Whole-world sweep (definitive):** scanning the entire genesis city found **7,834 distinct scenes, of which only 74 are v48/v49** (12 v48, 62 v49) — those are the two newest converter versions, so 74 is the complete population at those versions, not a sample (the rest of the world is still v35/v36/v44). Downloaded 73 (one manifest 404'd) and verified: **1,381 bundles / 10,761 objects → 100% byte-exact** across **15 Unity classes** — including ones with no explicit per-class builder (the generic TypeTree reader/writer handles them): 1 GameObject (1037), 4 Transform (1037), 21 Material (1037), 23 MeshRenderer (930), 28 Texture2D (955), 33 MeshFilter (958), 43 Mesh (1028), 49 TextAsset (1380), **64 MeshCollider (413), 74 AnimationClip (238), 91 AnimatorController (18), 95 Animator (18), 111 Animation (220), 137 SkinnedMeshRenderer (112)**, 142 AssetBundle (1380). This is the strongest serialization-fidelity evidence to date: the read→Value→write pipeline reproduces every object in real production scenes exactly. (Note: registry discovery requires a non-default `User-Agent` — the WAF 403s urllib's default. Rendering correctness is still the separate Explorer-load spike.)

  **Explorer load-path deep-dive (2026-05-29) — compatibility confirmed, fixtures are encoder-only.** Verified against `unity-explorer`:
  - **The Explorer does NOT use our TypeTree fixtures.** Those are an *encoder-side* input (they tell our writer the byte layout). The Explorer deserializes with Unity's runtime engine. So the fixture-regeneration de-risk (gitignored, rebuilt on demand) has zero effect on what the Explorer loads — confirmed sound.
  - **Unity versions:** converter (this repo) = **6000.2.6f2** (so its bundles, and ours, stamp that revision); Explorer = **6000.4.0f1**. Different Unity 6 patch. Production v49 bundles (6000.2.6f2) are loaded by the 6000.4.0f1 Explorer today, so cross-patch loading works — and there is **no** Unity-revision equality gate in the load path (`LoadAssetBundleSystem.cs`). Our bundles are byte-identical to the converter's, so they inherit this working condition.
  - **Load API:** `UnityWebRequestAssetBundle.GetAssetBundle` → `DownloadHandlerAssetBundle.GetContent` → `assetBundle.LoadAssetAsync<T>()` (`GetAssetBundleWebRequest.cs:22-41`, `LoadAssetBundleSystem.cs:174-182`). Standard runtime path; **no** TypeTree-driven loading, **no** CRC/hash/signature validation beyond Unity's internal UnityFS check.
  - **AB version gate:** only `intVersion >= AB_MIN_SUPPORTED_VERSION_{WINDOWS=15,MAC=16}` (`AssetBundleManifestVersion.cs:18-19`, `LoadAssetBundleManifestSystem.cs:76-80`). v48/v49 pass.
  - **metadata.json:** read via `assetBundle.LoadAsset<TextAsset>("metadata.json")`, parsed to `{timestamp,version,dependencies,mainAsset}`, deps loaded recursively (`LoadAssetBundleSystem.cs:30,87-110`). Our assembler emits exactly this shape.
  - **Bottom line:** texture bundles (fully built, no externals) will load. The format/version/metadata/loader contract is all satisfied. The one real correctness dependency for glb bundles is the shader external (CAB-path, corrected above), which lands in the not-yet-implemented Material builder.

  **Per-class glb value builders — Material + Mesh now byte-exact (2026-05-29).** The two remaining large builders are implemented and verified against real v49 (Unity 6000.2.6f2) glb bundles:
  - `build_material_value` (class 21, DCL/Scene): 12 root fields incl. the shader external PPtr, keyword vectors, and the UnityPropertySheet maps (m_TexEnvs / m_Ints / m_Floats / m_Colors). `verify-material` reports BYTE-EQUAL across 7 real materials (1 from the 2022.3 corpus + 6 v49).
  - `build_mesh_value` (class 43) + serialized-form `UnityMeshObject`: 25 root fields incl. m_VertexData (m_VertexCount + 14 ChannelInfo slots + interleaved blob), m_IndexBuffer, m_LocalAABB, m_StreamData, and the Unity-6 m_MeshLodInfo. Static-mesh empty sub-structures (blend shapes, bind pose, bone data, m_CompressedMesh) are hardcoded. `verify-mesh` reports BYTE-EQUAL across 6 v49 meshes (4–608 verts). The Mesh TypeTree is **version-specific** (Unity 6 added m_MeshLodInfo); verify-mesh guards bundle-revision == fixture-revision (a 2022.3 mesh is NOT byte-compatible).
  - With Texture2D/GameObject/Transform/MeshFilter/MeshRenderer/AssetBundle/TextAsset already verified, **every object class in a glb bundle now has a byte-exact value builder.** A real v49 glb bundle (untextured single mesh) is exactly 8 objects: GameObject, Transform, Material, MeshRenderer, MeshFilter, Mesh, TextAsset(metadata.json), AssetBundle.

  **Shader bake artifact — concrete values extracted + cross-bundle confirmed (2026-05-29).** New `parse_externals` in `serialized_file_reader.rs` parses the FileIdentifier table (additive; re-walks past type/object/script tables). Across all downloaded v49 glb bundles, `externals[0]` is **identical**: `guid=0, type_id=0, path="archive:/CAB-51fbd4c9d0fb3e603fd599ac9f5d01e1/CAB-51fbd4c9d0fb3e603fd599ac9f5d01e1"` — the StreamingAssets shader bundle's CAB, exactly as the corrected mechanism predicted (NOT a `.meta` GUID). The DCL/Scene Material's `m_Shader` PPtr resolves via `file_id=1` (→ externals[0]), `path_id=0x6a1984f5061ced9d`. So the shader bake artifact is just `{cab_path, path_id}` per platform, extractable from any real converter glb bundle. (One bundle carried a second external — a glb referencing two shader bundles — so the assembler must register externals per-Material, not assume exactly one.)

  **glTF→Unity MESH conversion reverse-engineered + byte-validated against production (2026-05-29).** `encode/gltf_mesh.rs::convert_glb_meshes` converts a source glb's meshes to `UnityMeshObject`s. Every transform rule was derived by converting the *source glb* (fetched from the catalyst by its CID) and diffing the result byte-for-byte against the *real Unity Mesh* in the corresponding ab-cdn v49 bundle (`verify-mesh-from-glb` harness). Rules:
  - **One Unity Mesh object per glb primitive** — a multi-primitive glb mesh becomes N same-named Mesh objects, each one submesh (confirmed: Cube.012's 2 prims → 2 separate "Cube.012" objects, NOT one 2-submesh mesh).
  - **Negate X** on position AND normal (glTF right-handed → Unity left-handed).
  - **UV `v → 1-v`**; UV channel (ch4, stream 1) emitted only when the primitive has `TEXCOORD_0`.
  - **Indices**: reverse winding per triangle (`a,b,c → a,c,b`) + widen to UInt32 (m_IndexFormat=1).
  - **Two-stream vertex layout**: stream 0 = position(12)+normal(12) interleaved (24B/vert), stream 1 = UV(8B/vert); **stream 0 padded to a 16-byte boundary** before stream 1.
  - **`m_MeshUsageFlags = 0x10`** iff the mesh's referencing node name ends `_collider` (DCL collider convention; CPU-readable for physics). Confirmed: `Lever_collider`→Cube.006, `view platform_collider`→Cube.013, `TrashCan_01_collider`→the 24v Untitled.313 — all flag 0x10; their non-collider siblings flag 0.
  - **Validation result**: across the downloaded v49 corpus, **12 of 13 production meshes reproduce byte-for-byte** (single-prim with/without UV, multi-prim, colliders, 4–608 verts). The 1 exception is a collider whose bounding-box center/extent differ in **2 bytes** — a sub-ULP float rounding nuance in Unity's `(min+max)*0.5f` on asymmetric bounds (≈microns; functionally irrelevant to rendering/physics). The geometry conversion is otherwise exact.

  **glTF→Unity MATERIAL conversion reverse-engineered + byte-validated (2026-05-29).** `encode/gltf_material.rs::convert_glb_material` converts a glTF PBR material to a DCL/Scene `UnityMaterial`, derived by diffing converted materials against real v49 Materials (`verify-material-from-glb`). Validated mapping (against the untextured opaque cube — **byte-exact except a 3-byte sub-ULP `_BaseColor` difference** from Unity's internal `pow`, ≈3e-7, far below 8-bit color):
  - **name** = `material_{index}` (NOT the glTF material name).
  - **m_Shader** = external PPtr `{file_id:1, path_id:0x6a1984f5061ced9d}`.
  - **valid keywords** = `_ADDITIONAL_LIGHT_SHADOWS, _FORWARD_PLUS, _MAIN_LIGHT_SHADOWS_CASCADE, _SHADOWS_SOFT`; tag `RenderType=Opaque`; `lightmapFlags=4`.
  - **m_DoubleSidedGI** = 1 when the glTF material is `doubleSided` (the @145 byte).
  - **_BaseColor** = linear→sRGB(baseColorFactor) (white if absent); **_Metallic** = metallicFactor; **_Smoothness = 1 − roughnessFactor** (confirmed: rough=1→smooth=0); **_Cull** = doubleSided ? 0 : 2; **customRenderQueue** = 2000.
  - **_SpecColor** = exactly `0.19999996` (the f32 just below 0.2 the shader ships); the rest is the DCL/Scene default property template (28 floats, 6 colors incl. ±2^31 clip sentinels, 8 texEnvs).
  - **Converter-version split in the corpus**: dizhvbhr/cmaucbdlyby use this `material_N` behaviour; bcq2/fwip use a default `DCL_Scene`-named variant (renderQueue=-1, Cull=2) — a distinct path, not implemented.
  - **NOT yet handled**: texture PPtr wiring (`_BaseMap` etc. → in-bundle Texture2D, assembly-time; `MaterialTextures` is the hook), and non-opaque alpha modes (BLEND/MASK change Surface/Blend/SrcBlend/DstBlend/ZWrite/Cutoff/renderQueue).

  **Full glb scene-graph generalization — structurally validated vs production (2026-05-29).** `scene_encoder::encode_glb_bundle` calls `convert_glb_scene` + `convert_glb_material` + `assemble_glb_graph` and returns a real `Bundle` (was `NotImplemented`). `gltf_mesh::convert_glb_scene` walks the glb nodes into a `GlbScene` (per-node TRS, primitives, `_collider` flag); `bundle_assembler::assemble_glb_graph` builds the full GameObject graph:
  - **single primitive** → one GameObject (named by the glb hash) carrying Transform+MeshFilter+renderer directly (matches Unity's collapse);
  - **multiple** → an entity-root GameObject (hash name, Transform-only) + per-node child GameObjects (prim 0 = node name, father=root; prims 1..N = `{mesh}_{i}`, father=node);
  - **MeshRenderer for visible meshes, `MeshCollider` (class 64, new `build_mesh_collider_value`) for `_collider` nodes**; one Mesh per primitive, one Material per visible primitive; node TRS applied; metadata + AssetBundle (mainAsset = root GO) + shader external.
  - **Validation (`verify-glb-encode`)**: across dizhvbhr / cmaucbdlyby / fwip / clyuj / bcq2 (single, multi-mesh, multi-primitive, collider cases), the **structural object histogram — GameObject/Transform/MeshFilter/MeshRenderer/MeshCollider/Mesh — matches production EXACTLY**, and **every emitted Mesh object is byte-equal to production**. Scope: Windows (shader CAB Windows-only); glbs with no meshes return a `PartialFailure` (ENCODER_FALLBACK_TO_UNITY covers them). (Made `mod types` public — the assembler API takes `BuildTarget`.)

  **Texture wiring landed (2026-05-29).** `assemble_glb_graph` now emits an in-bundle `Texture2D` (class 28) per base-color image referenced by a visible primitive's material and wires it into the material's `_BaseMap` PPtr. `encode_glb_bundle::extract_base_color_images` resolves `material.baseColorTexture → textures[].source → images[].bufferView` and pulls the **embedded** PNG/JPG bytes from the glb BIN chunk (external-uri images aren't threaded yet — they'd need the entity contentMap + fetched bytes). Validated by `verify-glb-encode`: textured bundles parse back, the structural graph still matches and meshes stay byte-equal, and `_BaseMap` resolves to the in-bundle texture. Two known deltas: textures are **RGBA32** (loadable, but not byte-identical to Unity's BC7 — a compression optimisation), and Unity emits **2** Texture2D + 2 Material per textured glb material where the encoder emits 1 each.

  **Streamed textures landed (2026-05-29).** Texture pixels now stream into a `.resS` resource node via `m_StreamData` (was inline), so textured glb bundles emit the same two-node directory layout as production — `CAB-<32hex>` (SerializedFile) + `CAB-<32hex>.resS`, with the Texture2D's `m_StreamData.path = archive:/CAB-<x>/CAB-<x>.resS`. `cab_name_for(bundle_name)` derives a deterministic 32-hex CAB (breaking the .resS-path ↔ SF-content-hash circularity). `texture_writer::serialize_texture2d_streamed` + `unityfs_writer::DirectoryNode::{serialized_file_named,resource}` + `assemble_unityfs(cab_name, ress)` carry it. Confirmed against real bundles: identical `{SF, .resS}` node structure, Texture2D streamed, parses back, meshes still byte-equal. Still RGBA32 1-mip (not BC7+mips) and 1× count (not 2×) — see below.

  **Real Texture2D spec — reverse-engineered from converted assets (2026-05-29, `dump-fields` class 28).** Production texture objects are tiny (208 bytes) because the pixels are **streamed**: `m_Width/m_Height=512`, `m_TextureFormat=25` (**BC7**), `m_MipCount=10` (full chain), `m_CompleteImageSize=349552`, `m_IsReadable=0`, and `m_StreamData = {offset, size=349552, path}` pointing at a **`.resS` resource sidecar** (a 2nd UnityFS directory node holding the BC7+mip bytes). The encoder currently emits a single inline RGBA32 Texture2D (format 4, 1 mip, pixels in the object) — loadable but structurally divergent and ~4–5× larger uncompressed. Matching production needs: (a) a BC7 encoder + mip-chain generation, (b) the streamed Texture2D layout (m_StreamData → .resS), (c) a `.resS` node in the UnityFS writer. BC7 is also not cleanly byte-comparable across encoders, so this stays an Explorer-confirmed optimisation rather than a byte-match target.

  **Material/Texture2D count parity — matched (2026-05-29).** The rule (worked out across the corpus): `materials = (number of glb materials) + 1` extra untextured `DCL_Scene` default, and **2× Texture2D per referenced image** (one wired into `_BaseMap`, one unreferenced sibling). `assemble_glb_graph` now pre-creates one shared Material per glb material (visible MeshRenderers reference it) + the default, and emits two Texture2D per image. **Result: `verify-glb-encode` asserts the FULL object histogram (incl. class 21 Material + class 28 Texture2D) and it matches production EXACTLY** across dizhvbhr / cmaucbdlyby / fwip / bcq2 (the complete object composition is now identical for non-animated bundles); meshes stay byte-equal. The orphan default material + duplicate texture are emitted to match the count; their exact rendering role is a Unity quirk (they're unreferenced by visible renderers).

  **Multi-platform shader CAB — Windows + Mac (2026-05-29).** `shader_cab_path` returns the per-platform DCL/Scene shader-bundle CAB: Windows `archive:/CAB-51fbd4c9d0fb3e603fd599ac9f5d01e1/…`, Mac `archive:/CAB-5ba4993b7ea166819a0af9aec5b25b8c/…` (both extracted from real v49 bundles via `parse_externals`, consistent across the corpus). The Material's `m_Shader` path_id is platform-independent (`0x6a1984f5061ced9d`). WebGL is **out of scope** (not a supported target) — it returns None → `PartialFailure` → Unity. Mac mesh objects confirmed byte-equal to our conversion (geometry is platform-independent).

  **Independent loader validation via UnityPy — and a real interop bug fixed (2026-05-29).** Validating the encoder's output **without Unity** is possible with UnityPy (MIT, a third-party TypeTree-driven Unity reader — `scripts/validate-with-unitypy.py`, `pip install UnityPy`, run with `/usr/bin/python3` here since the Homebrew py3.14 has a broken pyexpat). `encode-glb-to-file <glb> <out> [windows|mac]` writes a bundle for it. UnityPy loading our bundle is independent evidence (our own reader grading our own writer is weak). It **immediately caught a real bug**: our `write_bundle` didn't 16-byte-align the BlockInfo (UnityFS format ≥ 7 / Unity 6 requires it) nor set `0x200` — so UnityPy/Unity read the BlockInfo from the wrong offset ("corrupt LZ4"), while our own (lenient) reader round-tripped the unaligned output and hid it. Fixed (`unityfs_writer`: set `0x200`, 16-align BlockInfo + data, matching real bundles' `0x243`). **Result: UnityPy now loads our cube / textured-collider / multi-primitive bundles with 0 deserialize failures, every object readable (mesh verts, material shader external, texture, GameObject graph), and the object histogram identical to production.** This is the strongest non-Explorer validation available; rendering is still the one Explorer-only question.

  **External-uri textures — structurally already correct (2026-05-29).** For a glb whose image is an external `uri` (not an embedded bufferView — e.g. haylvm's `file1.png`), production emits **no in-bundle Texture2D**: the texture is a *separate* leaf bundle, the material's `_BaseMap` references it via a SerializedFile external (a 2nd externals entry beyond the shader), and the texture CID rides in `metadata.json` deps. The encoder already matches this shape — it only emits an in-bundle Texture2D for *embedded* images, so for haylvm the histogram is **identical to production** (17 objects, no Texture2D, Material 3=3; UnityPy: 0 deserialize failures). What's NOT wired: the `_BaseMap` external PPtr to the separate texture bundle (so the material renders untextured). That wiring is cross-bundle (needs the texture leaf bundle's CAB + the texture's path_id within it) and its *resolution* is Explorer-gated — UnityPy can't follow cross-bundle externals — so it's deferred to the spike.

  **BC7 textures landed — pure-Rust, validated (2026-05-31).** Textures now encode to **BC7** (`m_TextureFormat=25`) with a full mip chain via `encode/bc7.rs` (a dependency-free mode-6 encoder + 2×2 box-filter mips), replacing RGBA32. Chose pure-Rust over `intel_tex_2` to avoid a native ISPC build dependency (and crates.io was flaky here). Validated with UnityPy (independent BC7 decoder): our texture reports `512×512 fmt=25 mips=10 m_CompleteImageSize=349552` — **identical to production** — and **UnityPy decodes it to a valid 512×512 RGBA image**. Quality is below an ISPC encoder (mode-6 only, axis-aligned endpoints) but the format/block/mip byte sizes are exact and the stream is a valid decodable BC7. (Streamed in the `.resS`, as before.)

  **Animation structural pass — landed + validated (2026-05-31).** Animated glb scenes now emit one legacy `AnimationClip` (74) per glTF animation + an `Animation` (111) component bound to the root GameObject. The construction uses a new TypeTree-driven `default_value(nodes, idx)` generator (in `type_tree.rs` — mirrors the reader's dispatch to emit a structurally-valid default for any class) plus targeted field overrides, so the 2348-byte AnimationClip (incl. its 2140-byte `ClipMuscleConstant`) is produced without hand-modeling every field. Clips are legacy, named (main/activate/deactivate), `m_SampleRate=60`; **curves are empty — the glTF-keyframe→curve conversion is playback work, Explorer-gated.** Some fields (`m_Name`, `m_GameObject`) are set by POSITION because their TypeTree names resolve through Unity's common-strings table our parser doesn't fully map (they show as `common@NNN`). Validated via UnityPy: clyuj's object histogram is **identical to production** (27 objects incl. 3 AnimationClip + 1 Animation), 0 deserialize failures, clip names + the Animation→GameObject + Animation→clips bindings all read back correctly. (`verify-roundtrip` separately confirms AnimationClip/Animation *serialization* is byte-exact.)

  **Deep semantic field-diff — caught + fixed a real rendering bug (2026-05-31).** `scripts/deep-diff-unitypy.py` goes beyond object counts: it loads ours + a real bundle with UnityPy and diffs FIELD VALUES (Transform TRS, GameObject layer/tag/components, MeshRenderer flags, Material props, Mesh stats, Texture2D format, AnimationClip flags). It immediately found that **node transforms were copied raw from glTF (right-handed) instead of converted to Unity (left-handed)** — every object would render mislocated/misrotated. Fixed in `gltf_mesh::node_trs`: position → `(-x, y, z)`, rotation quaternion → `(x, -y, -z, w)`, scale unchanged (verified against production Transform values). Also fixed the orphan `DCL_Scene` material to use the shader's pristine defaults. **Result: dizhvbhr 9/9, cmaucbdlyby 18/18, haylvm 17/17 objects match production field-for-field; clyuj 24/27** — the 3 remaining are the animated nodes' baked-pose transforms (tied to the empty-curves limitation + animation setup, playback-gated) and a BC7-vs-ARGB32 texture-format choice (Unity keeps some textures uncompressed; only one corpus sample, clyuj, does so). This is the strongest no-Unity check yet — it validates VALUES, not just structure.

  **Full-corpus UnityPy validation (2026-05-31).** Across all 5 downloaded v49 scenes — single-mesh, textured, multi-primitive, collider, external-uri, animated — the encoder's bundle has an **object histogram identical to production and loads through UnityPy (independent reader) with 0 deserialize failures.** Combined with byte-equal meshes/materials and decode-verified BC7 textures, every structure checkable without Unity now matches. Also fixed a latent bug: the AssetBundle `mainAsset` was hardcoded to path_id 2 but pre-created textures/materials/clips take earlier ids — now uses the captured root-GameObject id.

  **What genuinely remains for the glb path — all now blocked on the Explorer or external inputs**: (1) **BC7/ASTC texture compression** (currently RGBA32 streamed in `.resS` — loadable, correct-but-larger; needs a BC7 encoder crate (ISPC) + the output isn't byte-comparable, only UnityPy-decodable); (2) **external-uri `_BaseMap` external wiring** (cross-bundle; resolution Explorer-gated); (3) **animations** (AnimationClip 74 / Animation 111 / Animator 95, seen in clyuj — a large glTF-keyframe→AnimationClip subsystem; the encoder currently drops them so animated scenes' histograms differ on those classes); (4) **non-opaque alpha modes** (no `alphaMode != OPAQUE` sample exists in the corpus to diff against — would be guessing); (5) the **Explorer-load spike** (visual render / shader-to-pixels). Everything checkable without Unity — byte-comparable conversions, full graph structure, complete object histogram (incl. Material/Texture2D counts), and independent loadability/deserialization via UnityPy — is validated against production. The remaining items each hit a real wall: a blocked/heavy dependency (BC7), cross-bundle resolution (external wiring), a large subsystem (animations), missing sample data (alpha), or visual rendering (the spike).

  Per-class verifier binaries committed at `encoder/src/bin/verify-{mesh-filter,transform,game-object}.rs`. Each takes a real bundle, extracts the matching object's bytes, runs our writer with the parsed values, byte-diffs. Currently exit-0 with `[verify] ✓ BYTE-EQUAL ✓` for the three above.

  **Two key bugs caught during this round**:
  - **Absolute-position alignment for the object table** — Unity 4-byte aligns object entries to their absolute metadata offset, not relative to the section start. Texture bundle's object_count happened to be 4-aligned; the v49 glb's wasn't. Fixed in `dump-object` + all verifiers.
  - **Wrapper-node descent for ALIGN_BYTES** — Unity's `string`, `TypelessData`, and `Array<T>` types are structural wrappers whose INNER node carries the alignment flag. Our walker's special-case dispatch for `Value::String` / `Value::Bytes` / `Value::Array` was bypassing the inner node, missing alignment padding. Fixed by descending one level when the outer node has exactly 1 child.

  **Unity 6 confirmed in production**: v49 bundles report `unity_revision=6000.2.6f2`. Previous AB versions (v35-v46) used `2022.3.12f1`. Switching Unity versions changes byte layouts in subtle places — the writer now handles both via heuristic byte_size LE/BE detection.

  **Still pending**: AssetBundle (class 142, 11 fields incl. complex map types), MeshRenderer (class 23, ~30 fields), Material (class 21, 3822-byte TypeTree), Mesh (class 43, 9400-byte TypeTree). Each needs its own iteration loop following the same pattern: dump TypeTree → fill in Value::Seq → verify against real bytes.

  **Per-class writer state (post-fixture extraction)**:
  - `encoder/baked-fixtures/typetrees/2022.3.12f1.bin` and `2022.3.12f1-glb.bin` — real TypeTree fixtures extracted from production ab-cdn bundles via the in-crate `extract-typetrees` binary. The texture fixture covers classes 28 (Texture2D), 142 (AssetBundle), 49 (TextAsset). The glb fixture covers 1 (GameObject), 4 (Transform), 21 (Material), 23 (MeshRenderer), 33 (MeshFilter), 43 (Mesh), 49 (TextAsset), 142 (AssetBundle).
  - `encoder/src/encode/type_tree_db.rs` — loads the fixture at encoder startup; per-class writers look up their class's parsed TypeTree by class_id.
  - `encoder/src/encode/texture_writer.rs` — **first end-to-end per-class writer**. PNG/JPG decode (via `image` crate) → RGBA32 → Value::Seq matching the real Texture2D TypeTree → bytes. Structurally verified against a real Unity bundle: `verify-texture-bundle` reports byte-equal field layout up through `m_TextureFormat`. Remaining diff is purely value differences from different inputs (placeholder PNG vs reference's BC7-compressed 256×256 texture), not structural bugs.
  - `encoder/src/encode/class_writers.rs` — Value-graph builder scaffolds for AssetBundle, GameObject, Transform, MeshFilter, MeshRenderer, Material, Mesh. Each one carries its field list (from the dumped TypeTree) and a TODO marker for filling in the Value::Seq positional contents. **None are end-to-end yet.** Iteration loop per class: `cargo run --example dump_class_tree -- <class_id>` to inspect → fill in builder → run verifier → fix byte-level discrepancies → repeat.
  - `encoder/src/bin/verify-texture-bundle.rs` — diff harness. Takes a real bundle, finds its Texture2D object bytes, runs our writer against a placeholder, byte-compares the post-`m_Name` regions. The same pattern extends to one verifier per class.
  - **TypeTree walker refactored to dispatch on `(byte_size, children_count, value_variant)`** instead of type-name strings, because Unity's TypeTrees reference field types via a common-strings table we don't fully ship. The dispatch is robust to placeholder type names like `"common@222"`.

  **Container-layer discrepancies caught (8 total, all fixed):** format version 6→8, cstring field order, BLOCK_INFO_AT_END flag bit (0x40→0x80), BLOCK_INFO_NEED_PADDING_AT_START (0x200), LZ4HC vs LZ4, SerializedFile header size 52→48, header endianness byte position 0x10→0x28, conditional `script_id`, TypeTree blob trailer (`type_dependencies_count` u32 LE), and one writer bug (object byte_size BE→LE caught by the verifier). The reader is now production-validated against real Unity 2022.3.12f1 bundles.

  **Cross-side parity test now lives in `encoder/src/catalyst_client.rs::tests::retry_after_parity_against_shared_fixture`** (inline unit test, was a separate integration test before). The integration-test layout failed to link against the `cdylib` napi-rs symbols at `cargo test` time; the inline unit test compiles into the lib's test harness without that constraint. Both the Rust test and `consumer-server/test/unit/retry-after-parity.spec.ts` consume the same `encoder/tests/fixtures/retry-after-cases.json` fixture.

  Added since the first scaffold landed:
  - **Real glTF/glb dep parser** at `encoder/src/encode/glb_parser.rs`. Mirrors the TS-side digester at `gltf-deps.ts:1-181` byte-for-byte (same GLB magic check, same JSON-chunk trailing-padding strip — 0x00 / 0x20 / 0x09 / 0x0a / 0x0d — same percent-decode rules, same posix-normalize semantics, same scheme/protocol-relative/leading-slash/query/fragment guards). 11 unit tests pin each parser branch.
  - **Dep-graph step** in `scene_encoder.rs` runs the parser against every fetched glb, resolves each URI against `contentMap`, builds the per-glb dep CID list that will eventually populate the bundle's inline `metadata.json` TextAsset. glbs whose JSON is unparseable land in `partial_failures[]` with reason `unparseable_glb` and are removed from the encode set — symmetric with the digester's `unparseable` skip reason.
  - **Submodule scaffolding** at `encoder/src/encode/{mesh,material,texture,unityfs}.rs` — typed Rust structs for `UnityMesh`, `UnityMaterial`, `UnityTexture2D`, `UnityFsBundle`, `SerializedFile`, vertex layout enums, texture format enums, AABB. Each writer is a `NotImplemented` TODO block with structured reference notes (TypeTree field ordering for Mesh / Material / Texture2D, BC7/ASTC/ETC2 crate suggestions, SerializedFile + UnityFS header byte layouts).
  - **Cross-side parity test**: shared fixture at `encoder/tests/fixtures/retry-after-cases.json` consumed by both `consumer-server/test/unit/retry-after-parity.spec.ts` (drives the TS `parseRetryAfterMs`) and `encoder/tests/retry_after_parity.rs` (drives the Rust `parse_retry_after_ms`). Adding a case in one place picks up on both sides automatically — single source of truth for the parity contract. Timestamp-independent cases only; HTTP-date cases stay in per-side specs.
