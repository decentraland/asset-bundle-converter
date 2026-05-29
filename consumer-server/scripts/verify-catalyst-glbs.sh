#!/usr/bin/env bash
#
# verify-catalyst-glbs.sh
#
# Probe every glb/gltf hash referenced by a scene's entity content map and
# report whether the catalyst (or whichever CDN fronts it) is serving each
# asset correctly. Detects the failure mode that's been biting per-asset
# digest runs: a poisoned Cloudflare cache entry at the worker's POP that
# returns a 200 OK with a truncated or empty body, while origin is healthy.
#
# For each glb hash the script issues two fetches:
#   1. The bare URL — what the worker uses on attempt 0; goes through the
#      CDN's normal cache path.
#   2. A cachebust URL (?<random_nonce>=1) — intended to force a CDN MISS
#      so the response comes from origin (modulo cache key configuration on
#      the target zone; see "Caveat" below).
#
# Compare the two body sizes:
#   - both 200, sizes match, length >= 20 -> healthy.
#   - 200/200, sizes differ OR cached < 20 bytes -> POISONED at this POP.
#   - any non-200 -> error.
#
# Caveat on cachebust: this technique only forces a MISS when the CDN's
# cache key includes query strings (Cloudflare's default). If the catalyst
# zone is configured to ignore query strings in the cache key, the "fresh"
# probe hits the same cache entry as the bare URL and the report shows
# both as identical sizes -- a false negative for the partially-truncated
# case. The < 20 byte floor below catches the most pathological 0-byte
# case anyway.
#
# Exit codes:
#   0 - all assets healthy
#   1 - at least one asset POISONED (cached differs from fresh, or cached < 20 B)
#   2 - at least one asset returned a non-200 status from either probe
#   3 - script setup / entity resolution failure (bad CLI args, catalyst
#       unreachable, entity not found, missing curl/jq)
#
# Usage:
#   ./verify-catalyst-glbs.sh <entityId> [contentServerUrl]
#
# Examples:
#   ./verify-catalyst-glbs.sh bafkreibvuyboe724agvjhh2pp2xe7mytqz2t5wvaw6g6fisle4yhhuyp54
#   ./verify-catalyst-glbs.sh <entityId> https://peer.decentraland.org/content
#
# Requirements: bash 4+, curl, jq. (Tested on Ubuntu 20.04+ / macOS 12+.)

set -uo pipefail

ENTITY_ID="${1:-}"
CONTENT_SERVER="${2:-https://peer.decentraland.today/content}"

if [[ -z "$ENTITY_ID" ]]; then
  echo "Usage: $0 <entityId> [contentServerUrl]" >&2
  exit 3
fi

# Strip any trailing slashes so we don't end up with double-slash URLs below.
CONTENT_SERVER="${CONTENT_SERVER%/}"

for cmd in curl jq; do
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "ERROR: '$cmd' not found in PATH" >&2
    exit 3
  fi
done

# 8 in-flight probes: gentle enough not to make the catalyst rate-limit us,
# fast enough to finish a ~70-glb scene in well under a minute.
CONCURRENCY=8
# Anything shorter than this is a strong "truncated body" smell. Real glbs
# start at 12-byte header + 8-byte chunk header = 20 bytes minimum even for a
# zero-content document; production glbs are KB-to-MB.
MIN_BYTES=20

TMPDIR_=$(mktemp -d)
trap 'rm -rf "$TMPDIR_"' EXIT

echo "=== Catalyst GLB Verification ==="
echo "entityId:      $ENTITY_ID"
echo "contentServer: $CONTENT_SERVER"
echo

# Step 1: resolve the entity to its content map.
printf "Fetching entity... " >&2
RESPONSE=$(curl -sf -X POST "$CONTENT_SERVER/entities/active" \
  -H 'Content-Type: application/json' \
  -d "{\"ids\":[\"$ENTITY_ID\"]}" 2>/dev/null) || {
  echo "FAILED" >&2
  echo "entity $ENTITY_ID not found on $CONTENT_SERVER" >&2
  exit 3
}
echo "" >&2

if [[ -z "$RESPONSE" || "$RESPONSE" == "[]" ]]; then
  echo "entity $ENTITY_ID not found on $CONTENT_SERVER" >&2
  exit 3
fi

# Extract glb/gltf entries as TAB-separated (hash<TAB>file) lines. mapfile is
# a bash 4+ builtin; using process substitution avoids a subshell so the
# array sticks around in the parent scope.
mapfile -t GLBS < <(echo "$RESPONSE" | jq -r '.[0].content[] | select(.file | test("\\.(glb|gltf)$"; "i")) | "\(.hash)\t\(.file)"')

TOTAL=${#GLBS[@]}
if [[ $TOTAL -eq 0 ]]; then
  echo "No glb/gltf assets in entity. Nothing to verify."
  exit 0
fi
echo "Found $TOTAL glb/gltf asset(s). Probing each one (cached + fresh)..."
echo

# Probe one glb. Reads from $CONTENT_SERVER, $MIN_BYTES, $TMPDIR_ in the env;
# emits a single TAB-separated line to stdout describing the result.
#
# Output columns (12):
#   1  status         healthy | poisoned | errored
#   2  hash
#   3  file
#   4  cached_bytes
#   5  fresh_bytes
#   6  cached_cf_cache_status   (or "n/a")
#   7  cached_age               (or "n/a")
#   8  cached_cf_ray            (or "n/a")
#   9  fresh_cf_cache_status    (or "n/a")
#  10  fresh_cf_ray             (or "n/a")
#  11  cached_http_status
#  12  fresh_http_status
probe_one() {
  local LINE=$1
  local HASH FILE
  HASH=$(printf '%s' "$LINE" | cut -f1)
  FILE=$(printf '%s' "$LINE" | cut -f2-)
  local BASE_URL="$CONTENT_SERVER/contents/$HASH"
  # date %s + 2x $RANDOM is portable (no %N) and unique enough across
  # concurrent workers within a single script run.
  local NONCE="cb$(date +%s)${RANDOM}${RANDOM}"

  local CACHED_HEADERS FRESH_HEADERS CACHED_OUT FRESH_OUT
  CACHED_HEADERS=$(mktemp)
  FRESH_HEADERS=$(mktemp)
  CACHED_OUT=$(curl -s -D "$CACHED_HEADERS" -w "%{http_code}|%{size_download}" \
    -H "Accept-Encoding: identity" -o /dev/null "$BASE_URL" 2>/dev/null) || CACHED_OUT="0|0"
  FRESH_OUT=$(curl -s -D "$FRESH_HEADERS" -w "%{http_code}|%{size_download}" \
    -H "Accept-Encoding: identity" -o /dev/null "${BASE_URL}?${NONCE}=1" 2>/dev/null) || FRESH_OUT="0|0"

  local CACHED_STATUS="${CACHED_OUT%%|*}"
  local CACHED_BYTES="${CACHED_OUT##*|}"
  local FRESH_STATUS="${FRESH_OUT%%|*}"
  local FRESH_BYTES="${FRESH_OUT##*|}"

  # Pull diagnostic headers with sed: strip the header name + space, strip
  # any trailing CR. grep -i tolerates servers that capitalize header names
  # inconsistently (the catalyst sends them lowercase, but the script
  # shouldn't break against any HTTP/1.x origin).
  local CACHED_CF CACHED_AGE CACHED_RAY FRESH_CF FRESH_RAY
  CACHED_CF=$(grep -i '^cf-cache-status:' "$CACHED_HEADERS" 2>/dev/null | head -1 | sed -E 's/^[^:]+: *//;s/\r$//')
  CACHED_AGE=$(grep -i '^age:' "$CACHED_HEADERS" 2>/dev/null | head -1 | sed -E 's/^[^:]+: *//;s/\r$//')
  CACHED_RAY=$(grep -i '^cf-ray:' "$CACHED_HEADERS" 2>/dev/null | head -1 | sed -E 's/^[^:]+: *//;s/\r$//')
  FRESH_CF=$(grep -i '^cf-cache-status:' "$FRESH_HEADERS" 2>/dev/null | head -1 | sed -E 's/^[^:]+: *//;s/\r$//')
  FRESH_RAY=$(grep -i '^cf-ray:' "$FRESH_HEADERS" 2>/dev/null | head -1 | sed -E 's/^[^:]+: *//;s/\r$//')
  rm -f "$CACHED_HEADERS" "$FRESH_HEADERS"

  local STATUS="healthy"
  if [[ "$CACHED_STATUS" != "200" || "$FRESH_STATUS" != "200" ]]; then
    STATUS="errored"
  elif (( CACHED_BYTES < MIN_BYTES )) || [[ "$CACHED_BYTES" != "$FRESH_BYTES" ]]; then
    STATUS="poisoned"
  fi

  printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' \
    "$STATUS" "$HASH" "$FILE" "$CACHED_BYTES" "$FRESH_BYTES" \
    "${CACHED_CF:-n/a}" "${CACHED_AGE:-n/a}" "${CACHED_RAY:-n/a}" \
    "${FRESH_CF:-n/a}" "${FRESH_RAY:-n/a}" \
    "$CACHED_STATUS" "$FRESH_STATUS"
}

# Run probes in parallel, capped at $CONCURRENCY. Each worker writes its
# single-line TSV result to its own file so concurrent writes can't
# interleave; we concatenate at the end.
START=$(date +%s)
JOB_NUM=0
for line in "${GLBS[@]}"; do
  JOB_NUM=$((JOB_NUM + 1))
  ( probe_one "$line" > "$TMPDIR_/r-$JOB_NUM" ) &
  # Throttle: if we have CONCURRENCY jobs in flight, wait for any to finish.
  # `wait -n` exits immediately if no children remain; `|| true` keeps the
  # script alive under `set -e` should we ever turn it on.
  while (( $(jobs -r 2>/dev/null | wc -l) >= CONCURRENCY )); do
    wait -n 2>/dev/null || true
  done
done
wait

cat "$TMPDIR_"/r-* > "$TMPDIR_/results.tsv"
ELAPSED=$(($(date +%s) - START))

HEALTHY=$(awk -F'\t' '$1=="healthy"{n++} END{print n+0}' "$TMPDIR_/results.tsv")
POISONED=$(awk -F'\t' '$1=="poisoned"{n++} END{print n+0}' "$TMPDIR_/results.tsv")
ERRORED=$(awk -F'\t' '$1=="errored"{n++} END{print n+0}' "$TMPDIR_/results.tsv")

POP="unknown"
FIRST_RAY=$(awk -F'\t' 'NR==1 {print $8}' "$TMPDIR_/results.tsv")
if [[ -n "$FIRST_RAY" && "$FIRST_RAY" != "n/a" ]]; then
  POP="${FIRST_RAY##*-}"
fi

if (( POISONED > 0 )); then
  echo "--- POISONED (cached body differs from fresh, or is suspiciously short) ---"
  awk -F'\t' '$1=="poisoned" {
    printf "  hash:   %s\n", $2
    printf "  file:   %s\n", $3
    printf "  cached: %s bytes  (cf-cache-status=%s, age=%ss)\n", $4, $6, $7
    printf "  fresh:  %s bytes  (cf-cache-status=%s)\n", $5, $9
    if (($5+0) > 0) printf "  ratio:  %d%%\n", $4 * 100 / $5
    else            printf "  ratio:  n/a\n"
    printf "\n"
  }' "$TMPDIR_/results.tsv"
fi

if (( ERRORED > 0 )); then
  echo "--- HTTP errors (non-200 from either probe) ---"
  awk -F'\t' '$1=="errored" {
    printf "  %s  %s\n", $2, $3
    printf "    cached: status=%s\n", $11
    printf "    fresh:  status=%s\n", $12
  }' "$TMPDIR_/results.tsv"
  echo
fi

echo "=== Summary ==="
echo "  POP (cf-ray): $POP"
echo "  total:        $TOTAL"
echo "  healthy:      $HEALTHY"
echo "  POISONED:     $POISONED"
echo "  errored:      $ERRORED"
echo "  elapsed:      ${ELAPSED}s"

if (( POISONED > 0 )); then
  HOST=$(echo "$CONTENT_SERVER" | awk -F/ '{print $3}')
  echo
  echo "ACTION -- purge these $POISONED URL(s) at the $HOST"
  echo "Cloudflare zone (purge by URL propagates globally to all POPs):"
  awk -F'\t' -v server="$CONTENT_SERVER" '$1=="poisoned" {print "  " server "/contents/" $2}' "$TMPDIR_/results.tsv"
fi

(( POISONED > 0 )) && exit 1
(( ERRORED > 0 )) && exit 2
exit 0
