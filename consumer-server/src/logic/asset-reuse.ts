import { Entity } from '@dcl/schemas'
import { ILoggerComponent } from '@well-known-components/interfaces'
import * as path from 'path'
import * as fs from 'fs/promises'
import * as crypto from 'crypto'
import { AppComponents } from '../types'
import { normalizeContentsBaseUrl } from '../utils'
import { bufferExtensions, fileExtension, gltfExtensions, textureExtensions } from './extensions'
import { parseGltfDepRefs, resolveUriToContentFile } from './gltf-deps'
import { isS3NotFound } from './s3-helpers'

// Re-export so callers still referencing `asset-reuse.ts` for this helper keep
// working. Single source of truth is `extensions.ts`.
export { fileExtension } from './extensions'

// Extensions whose bundles the converter actually uploads and we can therefore
// probe at the canonical prefix. `.bin` is deliberately absent: Unity never
// marks `.bin` files as their own asset bundles (`AssetBundleConverter.cs`
// `MarkAllAssetBundles` early-continues on `.bin`), so no `{hash}_{target}`
// object at the canonical prefix ever represents a buffer. Probing `.bin`
// hashes would just add S3 HEAD calls that always miss, and worse it would
// permanently block the full-cache short-circuit for every scene with a
// buffer file (which is most of them).
const PROBE_EXTENSIONS = new Set<string>([...gltfExtensions, ...textureExtensions])

// Unity-side extensions whose asset bundles have no inbound dependencies from
// other assets, so the converter can safely skip downloading & re-building
// them via the `-cachedHashes` flag when the canonical bundle already exists.
// Textures are intentionally excluded — they can still be referenced from
// within a non-cached GLTF during import, so we keep downloading them
// regardless of cache status. `.bin` is not here either: it never has a
// canonical bundle to hit in the first place (see PROBE_EXTENSIONS above).
const UNITY_SKIPPABLE_EXTENSIONS = new Set<string>([...gltfExtensions])

// Extensions that a `.glb` / `.gltf` bundle can reference as dependencies. The
// bundle output bytes embed the referenced dep bundle names (themselves derived
// from dep content hashes), so two scenes that share a glb source hash but
// differ in their dep set produce byte-different bundles — distinct canonical
// paths prevent cross-scene collision. Buffers ARE included here even though
// they're not probed directly: a `.gltf` (text) bundle's output DOES embed
// references to the buffer bundle Unity produces as part of the GLTF's own
// bundle, so the buffer hashes participate in the digest.
const GLB_DEP_EXTENSIONS = new Set<string>([...bufferExtensions, ...textureExtensions])

const GLTF_EXTENSIONS_SET = new Set<string>(gltfExtensions)

export type AssetCacheResult = {
  cachedHashes: string[]
  missingHashes: string[]
  // Hashes Unity can safely skip building. Subset of cachedHashes limited to file
  // extensions whose bundles have no inbound Unity dependencies from other assets.
  unitySkippableHashes: string[]
  // Composite-or-bare canonical bundle filename per content hash, so callers
  // (short-circuit manifest emit, post-Unity manifest append) don't have to
  // reconstruct the composite form.
  canonicalNameByHash: Record<string, string>
  // Per-glb/gltf deps digest — keyed by asset hash. Passed to Unity so it names
  // each glb/gltf bundle with the same composite key we probed and will upload to.
  // Non-glb entries (textures, buffers) don't appear in this map; their canonical
  // filename is hash-only.
  depsDigestByHash: ReadonlyMap<string, string>
}

/**
 * Deterministic digest of the entity's texture + buffer set. Folded into
 * glb/gltf canonical filenames so two scenes that share a glb source hash but
 * differ in deps land at distinct paths.
 *
 * Conservative superset — digests every texture/buffer in the entity, not just
 * the subset a specific glb actually references. Zero false-positive risk
 * (identical digest ⇒ identical dep set ⇒ identical Unity output). May miss
 * some cross-scene reuse when an entity carries loose non-glb textures; we
 * accept that trade-off.
 *
 * Sort is filename-primary, hash-secondary so it's stable regardless of
 * catalyst response order and robust to two different filenames sharing a hash.
 *
 * Exported for unit testing.
 */
export function computeDepsDigest(entityContent: ReadonlyArray<{ file: string; hash: string }>): string {
  const deps = entityContent.filter((e) => GLB_DEP_EXTENSIONS.has(fileExtension(e.file)))
  deps.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : a.hash < b.hash ? -1 : a.hash > b.hash ? 1 : 0))
  // Feed JSON.stringify of the sorted tuple array rather than a hand-rolled
  // `${file}\t${hash}\n` concatenation so a filename that happens to contain a
  // tab or newline can't line-shift its neighbour's bytes into an identical
  // digest for a different dep set. DCL filenames are well-formed in practice,
  // but correctness shouldn't rely on that.
  const payload = JSON.stringify(deps.map((d) => [d.file, d.hash]))
  // 32 hex = 128-bit. Birthday-paradox collision probability at k tuples is
  // ~k² / 2·2¹²⁸ ≈ k² / 6.8·10³⁸. Even at 10¹⁸ tuples (astronomically
  // beyond any realistic DCL scale) the probability is ~10⁻³; at 10⁹ it's
  // ~10⁻²¹. The earlier version truncated to 16 hex (64-bit) which was
  // also safely above DCL's scale, but for critical-infrastructure
  // headroom this is essentially free — 16 extra chars in the filename at
  // rest, invisible to clients (who read the manifest opaquely) and
  // negligible in every downstream consumer.
  return crypto.createHash('sha256').update(payload).digest('hex').slice(0, 32)
}

/**
 * Build the canonical bundle filename Unity's output drops into
 * `{abVersion}/assets/{filename}`. glb/gltf filenames embed the per-asset
 * digest looked up from `depsDigestByHash`; BINs and textures are keyed by
 * hash alone (they're leaves with no inbound dep refs from their own bundle).
 *
 * Throws for glb/gltf hashes missing from the map — that would mean the caller
 * is probing an asset whose deps we haven't digested, and silently falling back
 * to a bare `{hash}_{target}` name would mis-align the probe key with the
 * filename Unity will emit. Missing digest for non-glb extensions is fine
 * (they're leaves; the map isn't expected to contain them).
 */
export function canonicalFilenameForAsset(
  hash: string,
  ext: string,
  target: string,
  depsDigestByHash: ReadonlyMap<string, string>
): string {
  if (GLTF_EXTENSIONS_SET.has(ext)) {
    const digest = depsDigestByHash.get(hash)
    if (!digest) throw new Error(`missing per-asset deps digest for glb/gltf hash ${hash}`)
    return `${hash}_${digest}_${target}`
  }
  return `${hash}_${target}`
}

// Process-local LRU cache of canonical keys confirmed to exist in S3. Canonical
// bundles are immutable once written (immutable Cache-Control, content-addressed
// path), so a HIT is valid forever — we evict purely on usage pressure, not on
// time. MISSES are intentionally NOT cached: another worker racing the same asset
// may have just uploaded it, and a stale-miss would force pointless Unity
// re-conversion.
//
// The entries are plain canonical keys (`{abVersion}/assets/{hash}_{target}`) so
// that a version bump or a different build target never returns a false positive.
// NOTE: keys do NOT include the S3 bucket name — the cache assumes a worker is
// bound to a single CDN bucket for its lifetime, which is the current deploy
// shape (one bucket per worker pool). If we ever run a process that probes
// against multiple buckets (e.g. staging-vs-prod dual-writes), a HIT confirmed
// in bucket A would spuriously satisfy a later probe for bucket B. Either
// introduce the bucket into the key or instantiate one cache per bucket
// before making that deploy change.
// LRU ordering is maintained via JS Set insertion order — on every hit we
// delete + re-add the key so it becomes the most-recently-used entry, and on
// eviction we drop the first (least-recently-used) element.
//
// The members below are named function expressions that reference the
// `probeHitCache` module binding directly (not `this`), so destructured
// usage like `const { has, add } = probeHitCache; add(k); has(k)` still works
// — see the unit-test covering that pattern.
// Exported for unit testing.
export const probeHitCache = {
  hits: new Set<string>(),
  maxSize: 20_000,
  has: function (key: string): boolean {
    if (!probeHitCache.hits.has(key)) return false
    // Touch: move the key to the back of the Set so it's now the MRU entry.
    probeHitCache.hits.delete(key)
    probeHitCache.hits.add(key)
    return true
  },
  add: function (key: string) {
    // If the key is already present, just refresh its LRU position.
    if (probeHitCache.hits.has(key)) {
      probeHitCache.hits.delete(key)
      probeHitCache.hits.add(key)
      return
    }
    // New key + at capacity: evict the least-recently-used entry (front of Set).
    if (probeHitCache.hits.size >= probeHitCache.maxSize) {
      const lru = probeHitCache.hits.values().next().value
      if (lru !== undefined) probeHitCache.hits.delete(lru)
    }
    probeHitCache.hits.add(key)
  },
  clear: function () {
    probeHitCache.hits.clear()
  }
}

/**
 * Extract the leading `{hash}` portion of a Unity-emitted bundle filename.
 *
 * Bundle filenames Unity emits look like `{hash}_{target}` optionally followed
 * by `.br` / `.manifest` / `.manifest.br`. Extracting the hash prefix lets
 * callers do an O(1) `Set.has` lookup against `cachedHashes` regardless of
 * which variant the file is.
 *
 * Returns `null` when the name doesn't follow the hash-prefixed convention —
 * for instance, generic Unity artifacts like `AssetBundles` / `AssetBundles.manifest`
 * that aren't content-addressed. Callers treat `null` as "not a cacheable
 * bundle" and leave the file alone.
 *
 * @param name - A filename from `readdir(outDirectory)` (no path, no slashes).
 * @returns The leading hash, or `null` for generic / unrecognized names.
 */
function extractHashFromBundleName(name: string): string | null {
  const underscore = name.indexOf('_')
  const dot = name.indexOf('.')
  // pick the earlier delimiter that is actually present
  const firstDelim = underscore < 0 ? dot : dot < 0 ? underscore : Math.min(underscore, dot)
  if (firstDelim <= 0) return null
  return name.substring(0, firstDelim)
}

/**
 * S3 HEAD probe that normalizes "not found" into `false` and surfaces every
 * other error. Uses `isS3NotFound` so the predicate is in one place.
 *
 * @param s3 - Configured AWS S3 client.
 * @param bucket - Bucket to probe.
 * @param key - Key to HEAD.
 * @returns `true` if the object exists, `false` on 404.
 * @throws Any non-404 error reaching the SDK (500, auth failure, etc.).
 */
async function headExists(s3: AppComponents['cdnS3'], bucket: string, key: string): Promise<boolean> {
  try {
    await s3.headObject({ Bucket: bucket, Key: key }).promise()
    return true
  } catch (err: unknown) {
    if (isS3NotFound(err)) return false
    throw err
  }
}

/**
 * Array-map with bounded concurrency — runs `fn` over every element of `items`
 * in parallel with at most `concurrency` in-flight promises at a time. Results
 * come back in the same order as `items`.
 *
 * Used to bound S3 HEAD probes in the per-asset cache, S3 `CopyObject` calls in
 * the migration script, and parallel `fs.unlink` calls in the purge step —
 * enough to saturate throughput without exhausting the default HTTPS agent pool
 * or hitting the container's `ulimit -n` on low-limit hosts.
 *
 * If `fn` rejects for any item, the whole promise rejects on first failure
 * (Promise.all semantics). Workers already in flight for other items keep
 * running until natural completion — their results are discarded. Clamps
 * `concurrency` to at least 1 so a caller accidentally passing 0 doesn't
 * return an array of holes.
 *
 * @param items - Inputs to process.
 * @param concurrency - Maximum number of simultaneous `fn` invocations.
 * @param fn - Per-item worker. Called with each element of `items`.
 * @returns Array of results in input order.
 */
export async function mapBounded<T, R>(items: T[], concurrency: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  if (items.length === 0) return []
  const results: R[] = new Array(items.length)
  let cursor = 0

  async function worker() {
    while (true) {
      const idx = cursor++
      if (idx >= items.length) return
      results[idx] = await fn(items[idx])
    }
  }

  // Clamp to at least 1 so a caller accidentally passing 0 doesn't leave the
  // returned array full of holes.
  const workerCount = Math.min(Math.max(1, concurrency), items.length)
  await Promise.all(Array.from({ length: workerCount }, () => worker()))
  return results
}

/**
 * Fetcher function used by `computePerAssetDigests` to pull glb/gltf bytes
 * from the catalyst. Kept as a plain parameter (rather than a component
 * dependency) so tests can swap in a memory-backed fetcher without mocking
 * global fetch.
 */
export type GltfFetcher = (url: string, ext: '.glb' | '.gltf') => Promise<Buffer>

// 256 MB upper bound on a single glb/gltf download. Defence-in-depth against
// a malicious or corrupted catalyst entry that declares an unbounded body —
// without this, `arrayBuffer()` would buffer the whole response before we see
// it. DCL's largest legitimate glbs are ~tens of MB, so 256 is generous
// headroom without risking an OOM on the conversion worker.
const MAX_GLTF_DOWNLOAD_BYTES = 256 * 1024 * 1024
const GLB_JSON_START = 20
const GLTF_FETCH_ATTEMPTS = 3
const GLTF_FETCH_RETRY_BASE_MS = 250
// Upper bound on a server-supplied `Retry-After`. A catalyst that asks us to
// wait longer than this is effectively broken for our use case — SQS visibility
// timeout will retry the whole job sooner, and blocking here just hogs a worker
// slot. We cap and let the next attempt (or SQS) handle it.
const MAX_RETRY_AFTER_MS = 30_000

type FetchResponse = {
  ok: boolean
  status: number
  statusText: string
  headers: { get(name: string): string | null }
  body?: ReadableStream<Uint8Array> | null
  arrayBuffer(): Promise<ArrayBuffer>
}

class NonRetryableFetchError extends Error {}
class RetryableFetchError extends Error {
  /** Server-supplied hint (from `Retry-After`) parsed into ms. When set,
   * `withFetchRetries` uses this instead of its exponential-backoff formula
   * — the catalyst knows better than we do how long to wait under 429/503. */
  retryAfterMs?: number
  constructor(message: string, retryAfterMs?: number) {
    super(message)
    this.retryAfterMs = retryAfterMs
  }
}

/**
 * Parse an HTTP `Retry-After` value into milliseconds, clamped to
 * `[0, MAX_RETRY_AFTER_MS]`. RFC 7231 allows two forms:
 *   - delta-seconds (e.g. `"120"`) — by far the most common from catalysts.
 *   - HTTP-date (e.g. `"Wed, 21 Oct 2026 07:28:00 GMT"`) — rarer; clamped
 *     against `now` so a clock skew doesn't produce a negative delay.
 *
 * Returns `undefined` when the header is absent or unparseable — the caller
 * (`withFetchRetries`) then falls back to its exponential-backoff formula.
 * We intentionally don't surface parse errors: a malformed Retry-After is a
 * catalyst bug, not a reason to fail the whole fetch.
 *
 * Exported for unit testing.
 */
export function parseRetryAfterMs(raw: string | null): number | undefined {
  if (raw === null) return undefined
  const trimmed = raw.trim()
  if (trimmed === '') return undefined

  // delta-seconds: ASCII digits only. `Number('120abc')` would happily parse
  // to NaN here, but `Number('120')` → 120 and `Number('')` → 0, so we need
  // an explicit digits-only check to distinguish "0 seconds" from "not a
  // number".
  if (/^\d+$/.test(trimmed)) {
    const seconds = Number(trimmed)
    return Math.min(Math.max(0, seconds * 1000), MAX_RETRY_AFTER_MS)
  }

  // Anything remaining must be an HTTP-date — those always contain at least
  // one letter (weekday / month abbreviation). Without this check,
  // `Date.parse("-1")` silently succeeds (epoch-ish), and `Date.parse("1.5")`
  // would slip through on some engines, returning a misleading 0ms delta for
  // what is actually a malformed numeric value.
  if (!/[a-zA-Z]/.test(trimmed)) return undefined

  const dateMs = Date.parse(trimmed)
  if (Number.isNaN(dateMs)) return undefined
  const delta = dateMs - Date.now()
  return Math.min(Math.max(0, delta), MAX_RETRY_AFTER_MS)
}

/**
 * Read the declared `Content-Length` header as a number, or `-1` when absent.
 */
function contentLength(res: { headers: { get(name: string): string | null } }): number {
  return Number(res.headers.get('content-length') ?? '-1')
}

/**
 * Convert a full response body into a `Buffer` and enforce the download guard.
 */
async function responseBytes(url: string, res: { arrayBuffer(): Promise<ArrayBuffer> }): Promise<Buffer> {
  const bytes = Buffer.from(await res.arrayBuffer())
  if (bytes.length > MAX_GLTF_DOWNLOAD_BYTES) {
    throw new NonRetryableFetchError(
      `glb/gltf at ${url} buffered ${bytes.length} bytes > ${MAX_GLTF_DOWNLOAD_BYTES} (refusing to buffer)`
    )
  }
  return bytes
}

/**
 * Fail fast on non-2xx HTTP responses, classifying retryable status codes.
 *
 * For retryable statuses we also propagate any `Retry-After` hint into the
 * thrown error so `withFetchRetries` can respect the catalyst's preferred
 * backoff — important under sustained 429s where our fixed jitter formula
 * would hammer a cooperating server.
 */
function assertOkResponse(url: string, res: FetchResponse): void {
  if (!res.ok) {
    const message = `failed to fetch ${url}: ${res.status} ${res.statusText}`
    if (res.status === 408 || res.status === 429 || res.status >= 500) {
      const retryAfterMs = parseRetryAfterMs(res.headers.get('retry-after'))
      throw new RetryableFetchError(message, retryAfterMs)
    }
    throw new NonRetryableFetchError(message)
  }
}

/**
 * Reject responses whose declared payload length exceeds the download guard.
 */
function assertDeclaredLengthWithinGuard(url: string, res: FetchResponse): void {
  const declaredLength = contentLength(res)
  if (Number.isFinite(declaredLength) && declaredLength > MAX_GLTF_DOWNLOAD_BYTES) {
    throw new NonRetryableFetchError(
      `glb/gltf at ${url} declared Content-Length ${declaredLength} > ${MAX_GLTF_DOWNLOAD_BYTES} (refusing to buffer)`
    )
  }
}

/**
 * Require a valid `Content-Length` header when the response has no stream body.
 */
function requireFallbackContentLength(url: string, res: FetchResponse): void {
  const declaredLength = contentLength(res)
  if (!Number.isFinite(declaredLength) || declaredLength < 0) {
    throw new NonRetryableFetchError(`glb/gltf at ${url} has no stream body and no valid Content-Length guard`)
  }
  if (declaredLength > MAX_GLTF_DOWNLOAD_BYTES) {
    throw new NonRetryableFetchError(
      `glb/gltf at ${url} declared Content-Length ${declaredLength} > ${MAX_GLTF_DOWNLOAD_BYTES} (refusing to buffer)`
    )
  }
}

/**
 * Convert a Web stream chunk into a zero-copy `Buffer` view.
 */
function toBuffer(chunk: Uint8Array): Buffer {
  return Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength)
}

/**
 * Sleep for the requested number of milliseconds.
 */
async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Compute exponential backoff with jitter for GLB/GLTF retries.
 */
function retryDelayMs(attempt: number): number {
  const jitter = Math.floor(Math.random() * GLTF_FETCH_RETRY_BASE_MS)
  return GLTF_FETCH_RETRY_BASE_MS * Math.pow(2, attempt) + jitter
}

/**
 * Treat every fetch error except the explicit non-retryable wrapper as retryable.
 */
function isRetryableFetchError(err: unknown): boolean {
  return !(err instanceof NonRetryableFetchError)
}

/**
 * Fetch and fully buffer a GLTF/GLB response when no prefix-only optimization applies.
 */
async function fetchFullWithContentLengthGuard(url: string, res: FetchResponse): Promise<Buffer> {
  assertOkResponse(url, res)
  assertDeclaredLengthWithinGuard(url, res)
  if (res.body) return readWholeStream(url, res)

  requireFallbackContentLength(url, res)
  return responseBytes(url, res)
}

/**
 * Stream a full response body into memory with a hard upper bound.
 */
async function readWholeStream(url: string, res: FetchResponse): Promise<Buffer> {
  if (!res.body) throw new RetryableFetchError(`glb/gltf at ${url} returned no response body stream`)

  const reader = res.body.getReader()
  const chunks: Buffer[] = []
  let total = 0

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      const bytes = toBuffer(value)
      total += bytes.length
      if (total > MAX_GLTF_DOWNLOAD_BYTES) {
        throw new NonRetryableFetchError(
          `glb/gltf at ${url} streamed ${total} bytes > ${MAX_GLTF_DOWNLOAD_BYTES} (refusing to buffer)`
        )
      }
      chunks.push(bytes)
    }
  } catch (err: any) {
    try {
      await reader.cancel()
    } catch (_cancelErr: any) {}
    throw err
  } finally {
    reader.releaseLock()
  }

  return Buffer.concat(chunks, total)
}

/**
 * Stream only the JSON prefix needed from a GLB, then cancel the response body.
 */
async function readGlbJsonPrefix(url: string, res: FetchResponse): Promise<Buffer> {
  assertOkResponse(url, res)
  if (!res.body) {
    requireFallbackContentLength(url, res)
    return responseBytes(url, res)
  }

  const reader = res.body.getReader()
  const chunks: Buffer[] = []
  let total = 0
  let targetBytes: number | undefined

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      const bytes = toBuffer(value)
      const remaining = targetBytes === undefined ? bytes.length : Math.max(0, targetBytes - total)
      const kept = remaining >= bytes.length ? bytes : bytes.subarray(0, remaining)

      if (kept.length > 0) {
        chunks.push(kept)
        total += kept.length
      }

      if (targetBytes === undefined && total >= GLB_JSON_START) {
        const prefix = Buffer.concat(chunks, total)
        const jsonChunkLength = prefix.readUInt32LE(12)
        targetBytes = GLB_JSON_START + jsonChunkLength
        if (targetBytes > MAX_GLTF_DOWNLOAD_BYTES) {
          throw new NonRetryableFetchError(
            `glb/gltf at ${url} JSON chunk ${targetBytes} > ${MAX_GLTF_DOWNLOAD_BYTES} (refusing to buffer)`
          )
        }
      }

      if (targetBytes !== undefined && total >= targetBytes) {
        await reader.cancel()
        return Buffer.concat(chunks, targetBytes)
      }
    }
  } catch (err: any) {
    try {
      await reader.cancel()
    } catch (_cancelErr: any) {}
    throw err
  } finally {
    reader.releaseLock()
  }

  throw new NonRetryableFetchError(
    targetBytes === undefined
      ? `glb/gltf at ${url} ended before the 20-byte GLB JSON header was available`
      : `glb/gltf at ${url} ended after ${total} bytes, before JSON chunk end ${targetBytes}`
  )
}

/**
 * Retry a fetch operation on retryable HTTP or stream failures. When the error
 * carries a parsed `Retry-After` hint (populated by `assertOkResponse` on
 * 408/429/503 responses), the hint wins over our exponential-backoff formula
 * — a cooperating catalyst knows better than we do how long to back off.
 */
async function withFetchRetries<T>(fn: () => Promise<T>): Promise<T> {
  let lastError: unknown
  for (let attempt = 0; attempt < GLTF_FETCH_ATTEMPTS; attempt++) {
    try {
      return await fn()
    } catch (err: unknown) {
      lastError = err
      if (attempt === GLTF_FETCH_ATTEMPTS - 1 || !isRetryableFetchError(err)) throw err
      const hint = err instanceof RetryableFetchError ? err.retryAfterMs : undefined
      await sleep(hint ?? retryDelayMs(attempt))
    }
  }
  throw lastError
}

/**
 * Default fetcher — wraps native fetch with a non-ok status check, retries,
 * a Content-Length guard, and streaming reads. Binary GLBs are only streamed
 * through the embedded JSON chunk; text GLTFs are fully streamed because the
 * dependency refs can appear anywhere in the JSON document.
 *
 * Uses `arrayBuffer()` only as a guarded fallback for mocked / non-standard
 * responses that do not expose a stream body.
 */
async function defaultGltfFetcher(url: string, ext: '.glb' | '.gltf'): Promise<Buffer> {
  return withFetchRetries(async () => {
    const init = ext === '.glb' ? { headers: { 'Accept-Encoding': 'identity' } } : undefined
    const res = (await fetch(url, init)) as FetchResponse
    return ext === '.glb' ? readGlbJsonPrefix(url, res) : fetchFullWithContentLengthGuard(url, res)
  })
}

/**
 * Reason a glb/gltf was excluded from the digest map. `missing-deps` covers
 * the common production case where the glb references a texture/buffer URI
 * that is not present in the entity's `content` map — Unity can't resolve
 * the dependency either, so attempting conversion would fail. `unparseable`
 * covers structural defects in the glb itself (bad magic, truncated JSON
 * chunk, non-object root, URI escapes that violate the resolver's rules) —
 * Unity wouldn't be able to import it either.
 *
 * Both reasons are content-deterministic: re-running against the same entity
 * always produces the same skip set, so workers don't flap on retry.
 */
export type SkipReason = 'missing-deps' | 'unparseable'

export type SkippedAsset = {
  hash: string
  file: string
  reason: SkipReason
  /** Human-readable detail for log/metric inspection — first missing URI for
   * `missing-deps`, the parse/resolve error message for `unparseable`. Never
   * read programmatically; freeform text. */
  detail?: string
}

export type PerAssetDigestResult = {
  digests: ReadonlyMap<string, string>
  skipped: ReadonlyMap<string, SkippedAsset>
}

/**
 * Compute a per-glb/gltf deps digest for every gltf-extension asset in the
 * entity. For each glb/gltf: download the bytes, parse the embedded JSON to
 * enumerate its external URI refs, resolve each URI against `entity.content`
 * to get the `{file, hash}` tuples the glb actually depends on, and hash
 * that subset through `computeDepsDigest`.
 *
 * Two glbs with identical referenced dep sets (same file names, same content
 * hashes) produce identical digests regardless of ordering inside the glTF
 * JSON — guaranteed by `parseGltfDepRefs` dedup+sort on the way in and by
 * `computeDepsDigest`'s own sort. Two glbs whose dep sets differ in any entry
 * produce distinct digests.
 *
 * Returns `{ digests, skipped }`. A glb that references a URI absent from
 * `entity.content`, or whose bytes are structurally malformed, lands in
 * `skipped` instead of `digests` — the caller is expected to forward those
 * hashes to Unity so they're not converted (the bundle they'd produce can't
 * render in-world anyway). Catalyst fetch failures keep their throw
 * semantics: those are transient network conditions where retrying via SQS
 * is the right response, not a content defect.
 */
export async function computePerAssetDigests(
  entity: Pick<Entity, 'content'>,
  contentServerUrl: string,
  options?: { fetcher?: GltfFetcher; concurrency?: number }
): Promise<PerAssetDigestResult> {
  const fetcher = options?.fetcher ?? defaultGltfFetcher
  // 20 in-flight catalyst fetches — below the S3 HEAD probe concurrency (50)
  // because catalyst fetches are heavier and more rate-limit-sensitive, but
  // high enough to amortize TCP/TLS setup across a scene with dozens of glbs.
  const concurrency = options?.concurrency ?? 20

  const content = entity.content ?? []
  const contentByFile = new Map<string, string>()
  for (const c of content) contentByFile.set(c.file, c.hash)

  const contentsBaseUrl = normalizeContentsBaseUrl(contentServerUrl)

  const gltfEntries = content.filter((e) => GLTF_EXTENSIONS_SET.has(fileExtension(e.file)))
  const digests = new Map<string, string>()
  const skipped = new Map<string, SkippedAsset>()
  if (gltfEntries.length === 0) return { digests, skipped }

  type WorkerResult = { kind: 'ok'; hash: string; digest: string } | { kind: 'skip'; skip: SkippedAsset }

  const results = await mapBounded<(typeof gltfEntries)[number], WorkerResult>(
    gltfEntries,
    concurrency,
    async (entry): Promise<WorkerResult> => {
      const ext = fileExtension(entry.file) as '.glb' | '.gltf'
      // Fetch errors stay throws — they're transient and bubble up to
      // `executeConversion` where they trigger SQS retry. Only content-
      // determined defects (parse + resolve) become skips.
      const bytes = await fetcher(`${contentsBaseUrl}${entry.hash}`, ext)

      let uris: string[]
      try {
        uris = parseGltfDepRefs(bytes, ext)
      } catch (err: any) {
        return {
          kind: 'skip',
          skip: { hash: entry.hash, file: entry.file, reason: 'unparseable', detail: err?.message ?? String(err) }
        }
      }

      // Resolve URIs against entity content, dedup on (file, hash) — the glTF
      // URI layer already dedups by URI, but two distinct URIs could resolve to
      // the same content file via percent-encoding variants or path aliases.
      const seen = new Set<string>()
      const deps: Array<{ file: string; hash: string }> = []
      for (const uri of uris) {
        let resolved: string
        try {
          resolved = resolveUriToContentFile(uri, entry.file)
        } catch (err: any) {
          // Bad percent-encoding / scheme / escapes-root URIs are still
          // structural defects in the glTF — Unity wouldn't accept them
          // either. Treat as `unparseable` rather than `missing-deps` so
          // operators can distinguish "content team published a broken
          // entity" (missing deps) from "exporter emitted a malformed URI"
          // (unparseable) at the metric layer.
          return {
            kind: 'skip',
            skip: { hash: entry.hash, file: entry.file, reason: 'unparseable', detail: err?.message ?? String(err) }
          }
        }
        const hash = contentByFile.get(resolved)
        if (!hash) {
          return {
            kind: 'skip',
            skip: {
              hash: entry.hash,
              file: entry.file,
              reason: 'missing-deps',
              detail: `"${uri}" -> "${resolved}"`
            }
          }
        }
        const key = `${resolved}\0${hash}`
        if (seen.has(key)) continue
        seen.add(key)
        deps.push({ file: resolved, hash })
      }

      return { kind: 'ok', hash: entry.hash, digest: computeDepsDigest(deps) }
    }
  )

  for (const r of results) {
    if (r.kind === 'ok') digests.set(r.hash, r.digest)
    else skipped.set(r.skip.hash, r.skip)
  }
  return { digests, skipped }
}

type CheckAssetCacheParams = {
  entity: Pick<Entity, 'content'>
  abVersion: string
  buildTarget: string
  cdnBucket: string
  concurrency?: number
  /** Pre-computed per-asset deps digests keyed by asset hash. When supplied,
   * skips the re-computation that would otherwise happen inside
   * `checkAssetCache`. Callers that also need the digests (e.g. to pass to
   * Unity independently of whether the probe succeeded) should compute once
   * and pass through. Required in practice because computing digests involves
   * downloading glb bytes — the caller already has a catalyst URL in context. */
  depsDigestByHash?: ReadonlyMap<string, string>
  /** Catalyst URL used to download glb/gltf bytes when `depsDigestByHash` is
   * not supplied. Ignored when `depsDigestByHash` is provided. */
  contentServerUrl?: string
  /** Injectable fetcher for glb bytes — forwarded to `computePerAssetDigests`. */
  fetcher?: GltfFetcher
}

/**
 * Probe the canonical `{abVersion}/assets/{hash}_{buildTarget}` prefix for each valid
 * asset hash in the entity. Returns the partition of hashes (cached vs missing) plus
 * the subset of cached hashes whose file extension is safe to skip on the Unity side.
 */
export async function checkAssetCache(
  components: Pick<AppComponents, 'cdnS3' | 'logs' | 'metrics'>,
  params: CheckAssetCacheParams
): Promise<AssetCacheResult> {
  const { entity, abVersion, buildTarget, cdnBucket } = params
  // S3 HEAD is cheap and non-blocking; 50 saturates the probe phase for typical
  // scenes (dozens of assets) without exhausting the default HTTPS agent pool.
  const concurrency = params.concurrency ?? 50
  const logger = components.logs.getLogger('AssetReuse')

  let depsDigestByHash: ReadonlyMap<string, string>
  if (params.depsDigestByHash) {
    depsDigestByHash = params.depsDigestByHash
  } else {
    if (!params.contentServerUrl) {
      throw new Error('checkAssetCache: either depsDigestByHash or contentServerUrl must be supplied')
    }
    // Fallback path — used by tests and any caller that hasn't yet wired in
    // the per-asset digest pre-compute. Probe correctness is preserved
    // (skipped glbs aren't in `digests`, the probe loop below excludes
    // glb/gltf hashes missing from the digest map, so skipped hashes land
    // in neither `cachedHashes` nor `missingHashes`). What is NOT preserved
    // is observability: `result.skipped` is dropped here, so callers using
    // this branch get no signal about WHY a glb wasn't probed. The
    // production path in `executeConversion` always passes
    // `depsDigestByHash` explicitly and tracks `skipped` from its own
    // `computePerAssetDigests` call — that's the path that emits the warn
    // log + `ab_converter_glb_skipped_total` counter. New callers should
    // follow the production pattern rather than relying on this fallback.
    const result = await computePerAssetDigests(entity, params.contentServerUrl, { fetcher: params.fetcher })
    depsDigestByHash = result.digests
  }

  type Probe = { hash: string; skippable: boolean; filename: string; key: string }
  const seen = new Set<string>()
  const probes: Probe[] = []
  for (const entry of entity.content ?? []) {
    const ext = fileExtension(entry.file)
    // Probe only the file kinds Unity actually emits as their own asset
    // bundle — glb/gltf and textures. `.bin` is excluded because Unity
    // inlines buffers into their referencing GLTF's bundle rather than
    // producing a standalone `{hash}_{target}` object, so probing would
    // always miss and permanently block the full-cache short-circuit.
    if (!PROBE_EXTENSIONS.has(ext)) continue
    // Glbs/gltfs that the digest computation marked as broken (missing deps
    // or unparseable bytes) won't ever be converted. Skip them from the
    // probe so they appear in neither `cachedHashes` nor `missingHashes` —
    // the canonical bundle they'd point at can't exist (Unity won't produce
    // it), and counting them as a miss would force a Unity run for a scene
    // whose remaining assets might all be cached.
    if (GLTF_EXTENSIONS_SET.has(ext) && !depsDigestByHash.has(entry.hash)) continue
    if (seen.has(entry.hash)) continue
    seen.add(entry.hash)
    const filename = canonicalFilenameForAsset(entry.hash, ext, buildTarget, depsDigestByHash)
    probes.push({
      hash: entry.hash,
      skippable: UNITY_SKIPPABLE_EXTENSIONS.has(ext),
      filename,
      key: `${abVersion}/assets/${filename}`
    })
  }

  if (probes.length === 0) {
    return {
      cachedHashes: [],
      missingHashes: [],
      unitySkippableHashes: [],
      canonicalNameByHash: {},
      depsDigestByHash
    }
  }

  // Fast-path: skip S3 HEAD for hashes the hit-cache already confirmed as canonical.
  const hits: boolean[] = new Array(probes.length)
  const pendingIdx: number[] = []
  for (let i = 0; i < probes.length; i++) {
    if (probeHitCache.has(probes[i].key)) hits[i] = true
    else pendingIdx.push(i)
  }

  const hitCacheServed = probes.length - pendingIdx.length
  if (pendingIdx.length > 0) {
    const fetched = await mapBounded(pendingIdx, concurrency, (i) =>
      headExists(components.cdnS3, cdnBucket, probes[i].key)
    )
    for (let j = 0; j < pendingIdx.length; j++) {
      hits[pendingIdx[j]] = fetched[j]
      if (fetched[j]) probeHitCache.add(probes[pendingIdx[j]].key)
    }
  }

  if (hitCacheServed > 0) {
    components.metrics.increment(
      'ab_converter_asset_probe_hit_cache_total',
      { build_target: buildTarget, ab_version: abVersion },
      hitCacheServed
    )
  }
  if (pendingIdx.length > 0) {
    components.metrics.increment(
      'ab_converter_asset_probe_head_total',
      { build_target: buildTarget, ab_version: abVersion },
      pendingIdx.length
    )
  }

  const cachedHashes: string[] = []
  const missingHashes: string[] = []
  const unitySkippableHashes: string[] = []
  const canonicalNameByHash: Record<string, string> = {}

  for (let i = 0; i < probes.length; i++) {
    const { hash, skippable, filename } = probes[i]
    canonicalNameByHash[hash] = filename
    if (hits[i]) {
      cachedHashes.push(hash)
      if (skippable) unitySkippableHashes.push(hash)
    } else {
      missingHashes.push(hash)
    }
  }

  components.metrics.increment(
    'ab_converter_asset_cache_hits_total',
    { build_target: buildTarget, ab_version: abVersion },
    cachedHashes.length
  )
  components.metrics.increment(
    'ab_converter_asset_cache_misses_total',
    { build_target: buildTarget, ab_version: abVersion },
    missingHashes.length
  )

  logger.info('Asset cache probe complete', {
    total: probes.length,
    cached: cachedHashes.length,
    missing: missingHashes.length,
    unitySkippable: unitySkippableHashes.length,
    hitCacheServed,
    headRequests: pendingIdx.length,
    gltfAssetsDigested: depsDigestByHash.size
  } as any)

  return { cachedHashes, missingHashes, unitySkippableHashes, canonicalNameByHash, depsDigestByHash }
}

/**
 * Remove files whose hash is already canonicalized from the local output directory
 * so the existing `uploadDir` matcher uploads only new bundles. A file is considered
 * to belong to a cached hash when it is exactly the hash, or when its leading
 * `{hash}` segment (before the first `_` or `.`) is in `cachedHashes`. Runs in
 * O(entries + hashes) via a Set lookup on the extracted prefix.
 */
export async function purgeCachedBundlesFromOutput(
  outDirectory: string,
  cachedHashes: string[],
  logger: ILoggerComponent.ILogger
): Promise<number> {
  if (cachedHashes.length === 0) return 0
  const cached = new Set(cachedHashes)
  let entries: string[]
  try {
    entries = await fs.readdir(outDirectory)
  } catch {
    return 0
  }

  const toUnlink: string[] = []
  for (const entry of entries) {
    if (!cached.has(entry) && !cached.has(extractHashFromBundleName(entry) ?? '')) continue
    toUnlink.push(entry)
  }

  // Parallel unlink with a concurrency cap. Scenes with hundreds of cached assets
  // could otherwise fire that many simultaneous syscalls and hit ENFILE on
  // low-ulimit containers; 50 mirrors the S3 HEAD probe concurrency.
  const results = await mapBounded(toUnlink, 50, async (entry) => {
    try {
      await fs.unlink(path.join(outDirectory, entry))
      return true
    } catch (err: any) {
      logger.warn(`Failed to purge cached bundle ${entry}: ${err.message}`)
      return false
    }
  })

  return results.filter(Boolean).length
}
