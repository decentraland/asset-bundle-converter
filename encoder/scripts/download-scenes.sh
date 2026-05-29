#!/usr/bin/env bash
#
# download-scenes.sh — find converted Decentraland scenes at a target
# AB_VERSION (default v48/v49) and download their asset bundles locally
# for verification.
#
# Two phases:
#   1. DISCOVERY — sweep the parcel grid in BATCHED registry queries
#      (hundreds of pointers per POST), collect every scene whose
#      converted version matches, dedupe by entity id. Fast: a full-world
#      sweep is a few minutes.
#   2. DOWNLOAD — for each discovered scene, pull its bundles from ab-cdn.
#      This is the slow/large part; bounded by MAX_BUNDLES per scene.
#
# Usage:
#   scripts/download-scenes.sh [output_dir]
#
# Environment overrides:
#   VERSIONS="v48 v49"   space-separated AB versions to keep
#   TARGET=windows       build target (windows|mac|webgl)
#   RANGE=160            sweep parcels in [-RANGE, RANGE]
#   STEP=2               parcel grid step (1 = every parcel; 2 catches
#                        nearly all scenes since most span >=2x2)
#   BATCH=150            pointers per registry request
#   MAX_SCENES=0         cap discovered scenes to download (0 = all found)
#   MAX_BUNDLES=6        bundles to download per scene (0 = all)
#   DISCOVER_ONLY=0      1 = list scenes, skip downloading
#
# Output:
#   <output_dir>/discovered.txt          "version entityId" per scene
#   <output_dir>/<version>/<id>/<file>   downloaded bundles
#   <output_dir>/index.txt               "version id bundleCount" per scene
#
set -euo pipefail

REGISTRY="https://asset-bundle-registry.decentraland.org"
CDN="https://ab-cdn.decentraland.org"

OUT="${1:-./downloaded-scenes}"
VERSIONS="${VERSIONS:-v48 v49}"
TARGET="${TARGET:-windows}"
RANGE="${RANGE:-160}"
STEP="${STEP:-2}"
BATCH="${BATCH:-150}"
MAX_SCENES="${MAX_SCENES:-0}"
MAX_BUNDLES="${MAX_BUNDLES:-6}"
DISCOVER_ONLY="${DISCOVER_ONLY:-0}"

mkdir -p "$OUT"
DISCOVERED="$OUT/discovered.txt"
INDEX="$OUT/index.txt"

# REUSE_DISCOVERY=1 skips the sweep if a non-empty discovered.txt exists
# (lets you re-run the download phase without re-scanning the world).
if [ "${REUSE_DISCOVERY:-0}" = "1" ] && [ -s "$DISCOVERED" ]; then
  echo "[discover] reusing existing $DISCOVERED ($(wc -l < "$DISCOVERED" | tr -d ' ') scenes)"
else
: > "$DISCOVERED"

# ----------------------------------------------------------------------
# Phase 1: batched discovery
# ----------------------------------------------------------------------
echo "[discover] grid [-$RANGE,$RANGE] step $STEP, batch $BATCH, target=$TARGET, versions='$VERSIONS'"

# Python drives the batched sweep: generates the grid, POSTs in batches,
# filters by version, dedupes, and prints "version<TAB>id" lines.
python3 - "$REGISTRY" "$TARGET" "$RANGE" "$STEP" "$BATCH" "$VERSIONS" >> "$DISCOVERED" <<'PY'
import sys, json, urllib.request, urllib.error

registry, target, rng, step, batch, versions = sys.argv[1:7]
rng, step, batch = int(rng), int(step), int(batch)
want = set(versions.split())

coords = [f"{x},{y}" for x in range(-rng, rng + 1, step) for y in range(-rng, rng + 1, step)]
seen = set()
found = 0
total_batches = (len(coords) + batch - 1) // batch

def post(pointers):
    data = json.dumps({"pointers": pointers}).encode()
    req = urllib.request.Request(
        registry + "/entities/active", data=data,
        headers={
            "Content-Type": "application/json",
            # The registry's WAF 403s urllib's default User-Agent; any
            # real UA is accepted.
            "User-Agent": "dcl-encoder-corpus-sweep/1.0",
        })
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            return json.load(r)
    except Exception as e:
        sys.stderr.write(f"[discover]   batch error: {e}\n")
        return []

for bi in range(0, len(coords), batch):
    chunk = coords[bi:bi + batch]
    entities = post(chunk)
    for e in entities:
        eid = e.get("id")
        if not eid or eid in seen:
            continue
        seen.add(eid)
        ver = (e.get("versions", {}).get("assets", {}).get(target, {}) or {}).get("version")
        if ver in want:
            print(f"{ver}\t{eid}", flush=True)
            found += 1
    done = bi // batch + 1
    if done % 10 == 0 or done == total_batches:
        sys.stderr.write(f"[discover]   {done}/{total_batches} batches, "
                         f"{len(seen)} distinct scenes seen, {found} matching\n")

sys.stderr.write(f"[discover] complete: {len(seen)} distinct scenes, {found} matching {sorted(want)}\n")
PY

fi  # end discovery (REUSE_DISCOVERY guard)

n_found="$(wc -l < "$DISCOVERED" | tr -d ' ')"
echo "[discover] $n_found matching scenes → $DISCOVERED"

if [ "$DISCOVER_ONLY" = "1" ]; then
  echo "[discover] DISCOVER_ONLY=1 — done."
  # Per-version tally for convenience.
  awk '{print $1}' "$DISCOVERED" | sort | uniq -c
  exit 0
fi

# ----------------------------------------------------------------------
# Phase 2: download bundles
# ----------------------------------------------------------------------
: > "$INDEX"
scene_count=0
while IFS=$'\t' read -r ver id; do
  [ -z "${id:-}" ] && continue
  [ "$MAX_SCENES" -ne 0 ] && [ "$scene_count" -ge "$MAX_SCENES" ] && break

  manifest="$(curl -fsS --max-time 20 --compressed "$CDN/manifest/${id}_${TARGET}.json" 2>/dev/null || true)"
  [ -z "$manifest" ] && { echo "[download] $ver $id — no manifest, skip"; continue; }
  mapfile -t files < <(printf '%s' "$manifest" | jq -r '.files[]?' 2>/dev/null || true)
  [ "${#files[@]}" -eq 0 ] && continue

  dest="$OUT/$ver/$id"
  mkdir -p "$dest"
  downloaded=0
  for f in "${files[@]}"; do
    [ "$MAX_BUNDLES" -ne 0 ] && [ "$downloaded" -ge "$MAX_BUNDLES" ] && break
    case "$f" in *.json) continue ;; esac
    if curl -fsS --max-time 60 --compressed -o "$dest/$f" "$CDN/$ver/$id/$f" 2>/dev/null; then
      downloaded=$((downloaded + 1))
    fi
  done

  if [ "$downloaded" -gt 0 ]; then
    scene_count=$((scene_count + 1))
    echo "$ver $id $downloaded" >> "$INDEX"
    [ $((scene_count % 25)) -eq 0 ] && echo "[download] $scene_count scenes, $(find "$OUT" -type f ! -name '*.txt' ! -name '*.json' | wc -l | tr -d ' ') bundles so far"
  else
    rmdir "$dest" 2>/dev/null || true
  fi
done < "$DISCOVERED"

total_bundles="$(find "$OUT" -type f ! -name '*.txt' ! -name '*.json' | wc -l | tr -d ' ')"
echo "[download] done: $scene_count scenes, $total_bundles bundles → $OUT"
