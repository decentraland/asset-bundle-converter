#!/usr/bin/env bash
#
# regenerate-fixtures.sh — (re)build the TypeTree fixture the encoder
# loads, WITHOUT committing Unity-derived schema bytes to the repo.
#
# Why this exists: the fixture (encoder/baked-fixtures/typetrees/*.bin)
# is extracted from Unity-built bundles and encodes Unity's engine class
# schemas. Rather than vendoring that in version control (see the Legal &
# Licensing section of README.md), we regenerate it on demand here —
# in CI before tests, and on a dev box before running the verifiers.
#
# It is Unity-free: discovers a current production scene via the
# asset-bundle-registry, downloads a glb bundle + a texture bundle from
# ab-cdn (transient, not committed), and runs the in-repo
# `extract-typetrees` binary to produce a merged fixture covering every
# class the encoder emits.
#
# Usage:
#   scripts/regenerate-fixtures.sh
#
# Environment:
#   TARGET=windows                 build target
#   VERSIONS="v49 v48"             acceptable AB versions (newest first)
#   OUT=baked-fixtures/typetrees   output dir
#   RANGE / STEP / BATCH           discovery sweep tuning (see download-scenes.sh)
#
set -euo pipefail

cd "$(dirname "$0")/.."  # encoder crate root

REGISTRY="https://asset-bundle-registry.decentraland.org"
CDN="https://ab-cdn.decentraland.org"
TARGET="${TARGET:-windows}"
VERSIONS="${VERSIONS:-v49 v48}"
OUT="${OUT:-baked-fixtures/typetrees}"
UA="dcl-encoder-fixture-regen/1.0"

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

echo "[regen] discovering a current $TARGET scene at versions '$VERSIONS'…"

# Reuse the batched discovery from download-scenes.sh to find ONE scene,
# then we pick its richest bundles. DISCOVER_ONLY writes discovered.txt.
DISCOVER_ONLY=1 TARGET="$TARGET" VERSIONS="$VERSIONS" \
  RANGE="${RANGE:-60}" STEP="${STEP:-3}" BATCH="${BATCH:-150}" \
  bash scripts/download-scenes.sh "$tmp/disc" >/dev/null 2>&1 || true

scene_line="$(head -n1 "$tmp/disc/discovered.txt" 2>/dev/null || true)"
if [ -z "$scene_line" ]; then
  echo "[regen] ERROR: no $VERSIONS scene found in sweep. Widen RANGE or check connectivity." >&2
  exit 1
fi
ver="$(printf '%s' "$scene_line" | cut -f1)"
id="$(printf '%s' "$scene_line" | cut -f2)"
echo "[regen] using scene $ver $id"

# Fetch the manifest and split bundle filenames into glb (3 underscore
# segments: hash_digest_target) vs leaf (textures/buffers: hash_target).
manifest="$(curl -fsS --max-time 30 --compressed -A "$UA" "$CDN/manifest/${id}_${TARGET}.json")"
mapfile -t files < <(printf '%s' "$manifest" | jq -r '.files[]?' | grep -v '\.json$')

glb=""; leaf=""
for f in "${files[@]}"; do
  # 3-segment name (two underscores before the platform suffix) => glb.
  segs="$(printf '%s' "$f" | awk -F_ '{print NF}')"
  if [ "$segs" -ge 3 ] && [ -z "$glb" ]; then glb="$f"; fi
  if [ "$segs" -lt 3 ] && [ -z "$leaf" ]; then leaf="$f"; fi
  [ -n "$glb" ] && [ -n "$leaf" ] && break
done

inputs=()
for f in "$glb" "$leaf"; do
  [ -z "$f" ] && continue
  if curl -fsS --max-time 90 --compressed -A "$UA" -o "$tmp/$f" "$CDN/$ver/$id/$f"; then
    inputs+=("$tmp/$f")
    echo "[regen] downloaded $f ($(stat -f%z "$tmp/$f" 2>/dev/null || stat -c%s "$tmp/$f") bytes)"
  fi
done

if [ "${#inputs[@]}" -eq 0 ]; then
  echo "[regen] ERROR: could not download any bundle for $id" >&2
  exit 1
fi

# Build the extractor and run it over the inputs to read the Unity
# revision (we name the fixture after it).
echo "[regen] building extract-typetrees…"
cargo build --release --bin extract-typetrees --no-default-features >/dev/null 2>&1

# First pass to a temp file so we can read the unity_version it reports,
# then place at the version-named path.
mkdir -p "$OUT"
tmp_fixture="$tmp/fixture.bin"
log="$(target/release/extract-typetrees "$tmp_fixture" "${inputs[@]}" 2>&1)"
echo "$log"
uver="$(printf '%s' "$log" | sed -nE 's/.*unity ([0-9][^)]*)\).*/\1/p' | head -n1)"
[ -z "$uver" ] && uver="unknown"

final="$OUT/${uver}.bin"
cp "$tmp_fixture" "$final"
echo "[regen] wrote fixture → $final"
echo "[regen] (gitignored; regenerate via this script — do not commit)"
