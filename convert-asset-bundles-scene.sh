#!/usr/bin/env bash
# THIS FILE IS USED BY ENTRYPOINT OF THE ASSET BUNDLE CONVERTER

set -u  # fail if any env var is not set
set -e  # stop on first error

PROJECT_PATH="$(pwd)/asset-bundle-converter"
OUTPUT_DIR=../AssetBundlesTest
SCENE_ID="bafkreidudwlm33df2wpqvv4amaiorhcdatp77gf57cf6vidz5hnfipx244"
CONTENT_URL="https://peer.decentraland.org/content/contents/"
LOCAL_LOG_FILE="testResultLog.txt"

# --- Go into the npm project directory ---
echo "Entering scene-lod-entities-manifest-builder..."
pushd scene-lod-entities-manifest-builder > /dev/null

# --- NPM build step ---
echo "Checking build..."
if [ ! -d "dist" ]; then
  echo "No build found. Running npm run build..."
  npm run build
else
  echo "Build already exists."
fi

# --- NPM start step ---
echo "Starting scene manifest generation..."
npm run start --sceneid=$SCENE_ID --output=../asset-bundle-converter/Assets/_SceneManifest

# --- Return to root ---
popd > /dev/null

# --- Unity conversion ---
mkdir -p "$OUTPUT_DIR"

echo "Running AB converter for sceneId $SCENE_ID at $CONTENT_URL > $OUTPUT_DIR"
echo "Project path: $PROJECT_PATH"

"$UNITY_PATH" \
  -batchmode \
  -projectPath "$PROJECT_PATH" \
  -executeMethod DCL.ABConverter.SceneClient.ExportSceneToAssetBundles \
  -sceneCid "$SCENE_ID" \
  -logFile "$LOCAL_LOG_FILE" \
  -baseUrl "$CONTENT_URL" \
  -output "$OUTPUT_DIR"

UNITY_EXIT_CODE=$?
exit $UNITY_EXIT_CODE