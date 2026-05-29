#!/usr/bin/env node
/* eslint-disable no-console */
//
// verify-catalyst-glbs.js
//
// Probe every glb/gltf hash referenced by a scene's entity content map and
// report whether the catalyst (or whichever CDN fronts it) is serving each
// asset correctly. Detects the failure mode that's been biting per-asset
// digest runs: a poisoned Cloudflare cache entry at the worker's POP that
// returns a 200 OK with a truncated or empty body, while origin is healthy.
//
// For each glb hash the script issues two fetches:
//   1. The bare URL — what the worker uses on attempt 0; goes through the
//      CDN's normal cache path.
//   2. A cachebust URL (`?<random_nonce>=1`) — forces a CDN MISS so the
//      response comes from origin (modulo cache key configuration on the
//      target zone; see "Caveat" below).
//
// Compare the two body sizes:
//   - both 200, sizes match, length ≥ 20 → healthy.
//   - 200/200, sizes differ OR cached < 20 bytes → POISONED at this POP.
//   - any non-200 → error.
//
// Caveat on cachebust: this technique only forces a MISS when the CDN's
// cache key includes query strings (Cloudflare's default). If the catalyst
// zone is configured to ignore query strings in the cache key, the
// "fresh" probe hits the same cache entry as the bare URL and the report
// will look "healthy" (both 0 bytes) — that's a false negative. Treat
// matching-but-suspiciously-short responses (under 1 KB for an asset that
// real-world is tens or hundreds of KB) as suspicious even if reported
// healthy; the < 20 byte threshold below catches the most pathological
// case but a 1-byte tail of a broken cache fill would slip through.
//
// Exit codes:
//   0 — all assets healthy
//   1 — at least one asset POISONED (cached differs from fresh)
//   2 — at least one asset returned a non-200 status from either probe
//   3 — script setup / entity resolution failure (bad CLI args, catalyst
//       unreachable, entity not found)
//
// Usage:
//   node verify-catalyst-glbs.js <entityId> [contentServerUrl]
//
// Examples:
//   node verify-catalyst-glbs.js bafkreibvuyboe724agvjhh2pp2xe7mytqz2t5wvaw6g6fisle4yhhuyp54
//   node verify-catalyst-glbs.js <entityId> https://peer.decentraland.org/content
//
// Requires Node 18+ (uses the global `fetch`). No npm install needed.

'use strict'

const entityId = process.argv[2]
const contentServerUrl = (process.argv[3] || 'https://peer.decentraland.today/content').replace(/\/+$/, '')

if (!entityId) {
  console.error('Usage: node verify-catalyst-glbs.js <entityId> [contentServerUrl]')
  process.exit(3)
}

// 8 in-flight probes is gentle enough not to make the catalyst rate-limit us,
// fast enough to finish a 70-glb scene in well under a minute.
const CONCURRENCY = 8
// Anything shorter than this is a strong "truncated body" smell. Real glbs
// start at 12-byte header + 8-byte chunk header = 20 bytes minimum even for a
// zero-content document; production glbs are KB-to-MB.
const MIN_REASONABLE_GLB_BYTES = 20
// Same-Accept-Encoding match as the worker uses (asset-reuse.ts in the
// converter). Without forcing identity, the CDN/Node fetch may negotiate gzip
// and we'd be probing a different cache entry than the worker hits.
const FETCH_HEADERS = { 'Accept-Encoding': 'identity' }

async function fetchEntity() {
  let res
  try {
    res = await fetch(`${contentServerUrl}/entities/active`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: [entityId] })
    })
  } catch (err) {
    throw new Error(`could not reach ${contentServerUrl}: ${err.message}`)
  }
  if (!res.ok) throw new Error(`entities/active returned ${res.status} ${res.statusText}`)
  const body = await res.json()
  if (!Array.isArray(body) || body.length === 0) {
    throw new Error(`entity ${entityId} not found on ${contentServerUrl}`)
  }
  return body[0]
}

// Drain the response body and return the byte count plus the diagnostic
// headers we care about. Reading the body (rather than relying on
// Content-Length, which the catalyst doesn't always send) is the only way
// to detect truncated chunked responses — exactly the failure mode we're
// looking for.
async function fetchAndMeasure(url) {
  try {
    const res = await fetch(url, { headers: FETCH_HEADERS })
    let bytes = 0
    if (res.body) {
      const reader = res.body.getReader()
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        bytes += value.byteLength
      }
    }
    return {
      status: res.status,
      bytes,
      cfCacheStatus: res.headers.get('cf-cache-status'),
      cfRay: res.headers.get('cf-ray'),
      age: res.headers.get('age'),
      contentLength: res.headers.get('content-length')
    }
  } catch (err) {
    return { status: 0, bytes: 0, error: err.message }
  }
}

async function probeGlb({ hash, file }) {
  const baseUrl = `${contentServerUrl}/contents/${hash}`
  // Nonce combines time + random to be unique even across concurrent runs
  // against the same hash. ASCII alphanumerics only so the URL parses
  // cleanly regardless of any future server-side query handling.
  const nonce = `cb${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
  // Sequential probes (not Promise.all) so the cached probe finishes before
  // we issue the fresh one — if a previous run polluted the cachebust URL
  // with a broken cache entry, doing them serially gives us a chance to see
  // the cached state first.
  const cached = await fetchAndMeasure(baseUrl)
  const fresh = await fetchAndMeasure(`${baseUrl}?${nonce}=1`)
  return { hash, file, cached, fresh }
}

async function mapBounded(items, fn, concurrency) {
  const results = new Array(items.length)
  let cursor = 0
  let done = 0
  const total = items.length
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (cursor < items.length) {
      const idx = cursor++
      results[idx] = await fn(items[idx])
      done++
      if (done % 10 === 0 || done === total) {
        process.stderr.write(`  …${done}/${total}\r`)
      }
    }
  })
  await Promise.all(workers)
  process.stderr.write(' '.repeat(40) + '\r')
  return results
}

function classify(result) {
  const { cached, fresh } = result
  if (cached.status !== 200 || fresh.status !== 200) return 'errored'
  if (cached.bytes < MIN_REASONABLE_GLB_BYTES) return 'poisoned'
  if (cached.bytes !== fresh.bytes) return 'poisoned'
  return 'healthy'
}

function popFromCfRay(ray) {
  // cf-ray header is `<hex-id>-<POP3>` — last dash-separated segment is the POP code.
  if (!ray) return null
  const idx = ray.lastIndexOf('-')
  return idx === -1 ? null : ray.slice(idx + 1)
}

async function main() {
  console.log('=== Catalyst GLB Verification ===')
  console.log(`entityId:      ${entityId}`)
  console.log(`contentServer: ${contentServerUrl}`)
  console.log()

  process.stderr.write('Fetching entity…\r')
  const entity = await fetchEntity()
  const glbs = (entity.content || []).filter((c) => /\.(glb|gltf)$/i.test(c.file))
  process.stderr.write(' '.repeat(40) + '\r')

  if (glbs.length === 0) {
    console.log('No GLB/GLTF assets in entity content. Nothing to verify.')
    process.exit(0)
  }
  console.log(`Found ${glbs.length} glb/gltf asset(s). Probing each one (cached + fresh)…`)
  console.log()

  const startedAt = Date.now()
  const results = await mapBounded(glbs, probeGlb, CONCURRENCY)
  const elapsedSec = ((Date.now() - startedAt) / 1000).toFixed(1)

  const byClass = { healthy: [], poisoned: [], errored: [] }
  for (const r of results) byClass[classify(r)].push(r)

  const pop = (() => {
    for (const r of results) {
      const p = popFromCfRay(r.cached.cfRay) || popFromCfRay(r.fresh.cfRay)
      if (p) return p
    }
    return 'unknown'
  })()

  if (byClass.poisoned.length > 0) {
    console.log('--- POISONED (cached body differs from fresh, or is suspiciously short) ---')
    for (const r of byClass.poisoned) {
      const ratio = r.fresh.bytes > 0 ? `${Math.round((r.cached.bytes / r.fresh.bytes) * 100)}%` : 'n/a'
      console.log(`  hash:   ${r.hash}`)
      console.log(`  file:   ${r.file}`)
      console.log(
        `  cached: ${r.cached.bytes} bytes  (cf-cache-status=${r.cached.cfCacheStatus ?? 'n/a'}, age=${r.cached.age ?? 'n/a'}s)`
      )
      console.log(`  fresh:  ${r.fresh.bytes} bytes  (cf-cache-status=${r.fresh.cfCacheStatus ?? 'n/a'})`)
      console.log(`  ratio:  ${ratio}`)
      console.log()
    }
  }

  if (byClass.errored.length > 0) {
    console.log('--- HTTP errors (non-200 from either probe) ---')
    for (const r of byClass.errored) {
      console.log(`  ${r.hash}  ${r.file}`)
      console.log(`    cached: status=${r.cached.status}${r.cached.error ? ` err=${r.cached.error}` : ''}`)
      console.log(`    fresh:  status=${r.fresh.status}${r.fresh.error ? ` err=${r.fresh.error}` : ''}`)
    }
    console.log()
  }

  console.log('=== Summary ===')
  console.log(`  POP (cf-ray): ${pop}`)
  console.log(`  total:        ${results.length}`)
  console.log(`  healthy:      ${byClass.healthy.length}`)
  console.log(`  POISONED:     ${byClass.poisoned.length}`)
  console.log(`  errored:      ${byClass.errored.length}`)
  console.log(`  elapsed:      ${elapsedSec}s`)

  if (byClass.poisoned.length > 0) {
    console.log()
    console.log(
      `ACTION — purge these ${byClass.poisoned.length} URL(s) at the ${new URL(contentServerUrl).host}`
    )
    console.log('Cloudflare zone (purge by URL propagates globally to all POPs):')
    for (const r of byClass.poisoned) {
      console.log(`  ${contentServerUrl}/contents/${r.hash}`)
    }
  }

  if (byClass.poisoned.length > 0) process.exit(1)
  if (byClass.errored.length > 0) process.exit(2)
  process.exit(0)
}

main().catch((err) => {
  console.error(`FAILED: ${err.message}`)
  process.exit(3)
})
