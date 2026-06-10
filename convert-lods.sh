#!/usr/bin/env bash
# Local-dev helper for the LOD asset-bundle pipeline. Mirrors the CI step
# defined in .github/workflows/docker-common.yml but skips xvfb-run because
# it runs against a native Unity install (macOS) rather than the headless
# image. All values below have sensible defaults; override any of them
# from the environment if you need to point at a different scene / env.

set -u  # fail if any expanded var is unset (defaults below cover this)
set -e  # stop on first error

# --- Configurable defaults (override via env when invoking) --------------
UNITY_PATH="${UNITY_PATH:-/Applications/Unity/Hub/Editor/6000.2.6f2/Unity.app/Contents/MacOS/Unity}"
PROJECT_PATH="${PROJECT_PATH:-$(pwd)/asset-bundle-converter}"
LOD_URL="${LOD_URL:-https://lod-unity-bucket-dev-0871c25.s3.us-east-1.amazonaws.com/lods-unity/lods/bafkreiecbcziuwjcqrs2zbe7ncy2pssefgd4cg7vj5o4ywrn5umt6nobi4_1.glb}"
CONTENT_URL="${CONTENT_URL:-https://peer.decentraland.zone/content}"
OUTPUT_DIR="${OUTPUT_DIR:-../AssetBundlesTest}"
LOCAL_LOG_FILE="${LOCAL_LOG_FILE:-testResultLog.txt}"

if [ ! -x "$UNITY_PATH" ]; then
  echo "ERROR: Unity binary not found or not executable at: $UNITY_PATH" >&2
  echo "  Either fix the default in convert-lods.sh or override via env:" >&2
  echo "    UNITY_PATH=/path/to/Unity ./convert-lods.sh" >&2
  echo "  (also check that \$UNITY_PATH in your shell isn't set with a typo)" >&2
  exit 1
fi

# Wipe the download folder + its .meta so every run starts from a clean
# AssetDatabase state. Stale .meta files from a previous run on a different
# importer chain make Unity throw ArgumentOutOfRangeException on the first
# import — much faster to re-download than to chase it down.
rm -rf "$PROJECT_PATH/Assets/_DownloadedGLBs" "$PROJECT_PATH/Assets/_DownloadedGLBs.meta"

mkdir -p "$OUTPUT_DIR"

echo "Running LOD AB converter"
echo "  Unity:          $UNITY_PATH"
echo "  Project path:   $PROJECT_PATH"
echo "  LOD URL:        $LOD_URL"
echo "  Content server: $CONTENT_URL"
echo "  Output dir:     $OUTPUT_DIR"
echo "  Log file:       $LOCAL_LOG_FILE"

"$UNITY_PATH" \
  -batchmode \
  -projectPath "$PROJECT_PATH" \
  -executeMethod DCL.ABConverter.LODClient.ExportURLLODsToAssetBundles \
  -lods "$LOD_URL" \
  -contentServerUrl "$CONTENT_URL" \
  -output "$OUTPUT_DIR" \
  -logFile "$LOCAL_LOG_FILE"

UNITY_EXIT_CODE=$?
exit $UNITY_EXIT_CODE
