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

if [ ! -s "$tmp/disc/discovered.txt" ]; then
  echo "[regen] ERROR: no $VERSIONS scene found in sweep. Widen RANGE or check connectivity." >&2
  exit 1
fi

# A single plain scene only covers the common classes (GameObject, Transform,
# Material, MeshRenderer, MeshFilter, Mesh, Texture2D, TextAsset, AssetBundle).
# The encoder ALSO emits MeshCollider (64), AnimationClip (74), Animation (111),
# and SkinnedMeshRenderer (137) for collider/animated/skinned scenes — which
# appear only in SOME scenes. So accumulate bundles across up to MAX_SCENES
# discovered scenes until the scene-class set is covered. Animator (95) +
# AnimatorController (91) come ONLY from EMOTE bundles, which are NOT in the
# parcel grid — supply them via EXTRA_BUNDLE_URLS (space-separated CDN URLs).
MAX_SCENES="${MAX_SCENES:-40}"
NEED_SCENE_CLASSES="1 4 21 23 28 33 43 49 64 74 111 137 142"

# Build the extractor up front — the incremental coverage check below needs it.
echo "[regen] building extract-typetrees…"
cargo build --release --bin extract-typetrees --no-default-features >/dev/null 2>&1

inputs=()
n_scenes=0
while IFS=$'\t' read -r ver id _rest && [ "$n_scenes" -lt "$MAX_SCENES" ]; do
  [ -z "$ver" ] || [ -z "$id" ] && continue
  n_scenes=$((n_scenes + 1))
  manifest="$(curl -fsS --max-time 30 --compressed -A "$UA" "$CDN/manifest/${id}_${TARGET}.json" 2>/dev/null || true)"
  [ -z "$manifest" ] && continue
  # Take every glb + the first leaf from this scene (more glbs → more chance of
  # hitting collider/animated/skinned classes).
  leaf_taken=""
  while read -r f; do
    [ -z "$f" ] && continue
    segs="$(printf '%s' "$f" | awk -F_ '{print NF}')"
    if [ "$segs" -lt 3 ]; then
      [ -n "$leaf_taken" ] && continue
      leaf_taken=1
    fi
    out="$tmp/${id}_${f}"
    if curl -fsS --max-time 90 --compressed -A "$UA" -o "$out" "$CDN/$ver/$id/$f" 2>/dev/null; then
      inputs+=("$out")
    fi
  done < <(printf '%s' "$manifest" | jq -r '.files[]?' | grep -v '\.json$')

  # Stop early once the scene-class set is covered (cheap incremental check).
  [ "${#inputs[@]}" -eq 0 ] && continue
  have="$(target/release/extract-typetrees /dev/null "${inputs[@]}" 2>/dev/null | sed -nE 's/.*classes: \[(.*)\].*/\1/p' | tr -d ' ' | tr ',' ' ' || true)"
  missing=""
  for c in $NEED_SCENE_CLASSES; do printf '%s' " $have " | grep -q " $c " || missing="$missing $c"; done
  [ -z "$missing" ] && { echo "[regen] scene-class set covered after $n_scenes scenes"; break; }
done < "$tmp/disc/discovered.txt"

# Operator-supplied EMOTE/extra bundles for classes the parcel grid can't yield.
for url in ${EXTRA_BUNDLE_URLS:-}; do
  out="$tmp/extra_$(printf '%s' "$url" | md5 2>/dev/null || printf '%s' "$url" | md5sum | cut -d' ' -f1)"
  if curl -fsS --max-time 90 --compressed -A "$UA" -o "$out" "$url" 2>/dev/null; then
    inputs+=("$out"); echo "[regen] +extra bundle $url"
  else
    echo "[regen] WARN: could not fetch EXTRA_BUNDLE_URL $url" >&2
  fi
done

if [ "${#inputs[@]}" -eq 0 ]; then
  echo "[regen] ERROR: could not download any bundle" >&2
  exit 1
fi
echo "[regen] collected ${#inputs[@]} bundles from $n_scenes scene(s)"

# Run the extractor over all inputs to read the Unity revision (we name the
# fixture after it) and produce the merged fixture.
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

# Coverage check: the encoder pre-flights against the same class set and falls
# back to Unity when a class is missing — so a deficient fixture silently routes
# scenes to Unity. Surface it here instead. Animator/AnimatorController (91/95)
# come only from emote bundles (EXTRA_BUNDLE_URLS); warn rather than fail since
# scenes still work without them.
have="$(printf '%s' "$log" | sed -nE 's/.*classes: \[(.*)\].*/\1/p' | tr -d ' ' | tr ',' ' ')"
miss_scene=""; for c in $NEED_SCENE_CLASSES; do printf '%s' " $have " | grep -q " $c " || miss_scene="$miss_scene $c"; done
miss_emote=""; for c in 91 95; do printf '%s' " $have " | grep -q " $c " || miss_emote="$miss_emote $c"; done
[ -n "$miss_emote" ] && echo "[regen] WARN: missing emote classes ($miss_emote) — set EXTRA_BUNDLE_URLS to an emote bundle, or emote scenes will fall back to Unity." >&2
if [ -n "$miss_scene" ]; then
  echo "[regen] ERROR: fixture missing scene classes ($miss_scene). Raise MAX_SCENES/RANGE so discovery hits a collider/animated/skinned scene." >&2
  exit 1
fi
echo "[regen] coverage OK: all scene classes present${miss_emote:+ (emote 91/95 absent — see warning)}"
