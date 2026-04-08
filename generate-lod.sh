#!/usr/bin/env bash
# Generate LOD for a Decentraland scene by coordinates

set -u

source ci-setup.sh

: "${COORDS:=20,4}"
: "${CONTENT_URL:=https://peer.decentraland.zone}"
: "${OUTPUT_DIR:=./lod-output}"
: "${LOCAL_LOG_FILE:=-}"

mkdir -p "$OUTPUT_DIR"

echo "Running LOD Generator for coords $COORDS at $CONTENT_URL > $OUTPUT_DIR"
echo "Project path: $PROJECT_PATH"

if [[ "$OSTYPE" == "linux-gnu"* ]]; then
  RUNNER="xvfb-run --auto-servernum --server-args='-screen 0 640x480x24'"
else
  RUNNER=""
fi

$RUNNER "$UNITY_PATH" \
  -batchmode \
  -projectPath "$PROJECT_PATH" \
  -executeMethod DCL.ABConverter.Editor.LODGeneratorWindow.GenerateLODBatchMode \
  -coords "$COORDS" \
  -baseUrl "$CONTENT_URL" \
  -output "$OUTPUT_DIR" \
  -logFile "$LOCAL_LOG_FILE"

UNITY_EXIT_CODE=$?

exit $UNITY_EXIT_CODE
