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
