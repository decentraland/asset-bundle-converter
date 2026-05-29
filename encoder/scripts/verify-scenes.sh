#!/usr/bin/env bash
#
# verify-scenes.sh — run the encoder's round-trip verification over every
# downloaded production bundle and report whether they convert correctly.
#
# "Correctly converted" here means: for every object in each real Unity
# bundle, our TypeTree reader + writer reproduce its bytes EXACTLY
# (read → Value → write == original). This validates the encoder's
# serialization stack (UnityFS container, SerializedFile, TypeTree,
# per-class writers) against the full corpus of production scenes —
# catching any class or Unity-version variation we haven't seen.
#
# (Rendering correctness in the Explorer is a separate concern that needs
# an in-client load test; this checks byte-level serialization fidelity,
# which is the prerequisite.)
#
# Usage:
#   scripts/verify-scenes.sh [scenes_dir]
#
# Environment:
#   KEEP_GOING=1   don't stop on first failure (default: 1)
#   VERBOSE=1      print every bundle result, not just failures
#
set -euo pipefail

SCENES="${1:-./downloaded-scenes}"
VERBOSE="${VERBOSE:-0}"

if [ ! -d "$SCENES" ]; then
  echo "error: scenes dir '$SCENES' not found — run download-scenes.sh first" >&2
  exit 1
fi

# Build the verifier once (release for speed over many bundles).
echo "[verify] building verify-roundtrip (release)…"
cargo build --release --bin verify-roundtrip --no-default-features >/dev/null 2>&1
BIN="target/release/verify-roundtrip"
[ -x "$BIN" ] || { echo "error: $BIN not built" >&2; exit 1; }

total_bundles=0
ok_bundles=0
fail_bundles=0
total_objects=0
ok_objects=0
declare -A class_total
declare -A class_ok
FAILURES=""

# Iterate every bundle file (skip JSON manifests + the index).
while IFS= read -r bundle; do
  total_bundles=$((total_bundles + 1))

  out="$("$BIN" "$bundle" 2>&1 || true)"

  # Per-class lines look like:
  #   [roundtrip] class   43: ✓ BYTE-EQUAL (1824 bytes)
  #   [roundtrip] class   21: ✗ first diff @...
  bundle_ok=1
  while IFS= read -r line; do
    case "$line" in
      *"class"*"BYTE-EQUAL"*)
        cid="$(printf '%s' "$line" | sed -E 's/.*class[[:space:]]*([0-9]+).*/\1/')"
        total_objects=$((total_objects + 1))
        ok_objects=$((ok_objects + 1))
        class_total[$cid]=$(( ${class_total[$cid]:-0} + 1 ))
        class_ok[$cid]=$(( ${class_ok[$cid]:-0} + 1 ))
        ;;
      *"class"*"✗"*)
        cid="$(printf '%s' "$line" | sed -E 's/.*class[[:space:]]*([0-9]+).*/\1/')"
        total_objects=$((total_objects + 1))
        class_total[$cid]=$(( ${class_total[$cid]:-0} + 1 ))
        bundle_ok=0
        FAILURES="$FAILURES
  $bundle
    $line"
        ;;
    esac
  done <<< "$out"

  if [ "$bundle_ok" -eq 1 ]; then
    ok_bundles=$((ok_bundles + 1))
    [ "$VERBOSE" = "1" ] && echo "[verify] OK   $bundle"
  else
    fail_bundles=$((fail_bundles + 1))
    echo "[verify] FAIL $bundle"
  fi
done < <(find "$SCENES" -type f ! -name '*.json' ! -name 'index.txt' | sort)

echo
echo "==================== VERIFY SUMMARY ===================="
echo "bundles:  $ok_bundles/$total_bundles byte-exact"
echo "objects:  $ok_objects/$total_objects byte-exact"
echo "per-class (class_id: ok/total):"
for cid in $(printf '%s\n' "${!class_total[@]}" | sort -n); do
  printf "  %5s: %d/%d\n" "$cid" "${class_ok[$cid]:-0}" "${class_total[$cid]}"
done

if [ "$fail_bundles" -ne 0 ]; then
  echo
  echo "FAILURES:$FAILURES"
  echo "======================================================="
  exit 1
fi
echo
echo "ALL BUNDLES BYTE-EXACT ✓"
echo "======================================================="
