#!/usr/bin/env bash

function disable_sentry()
{
  # Disable Sentry
  sed -i 's/<Enabled>k__BackingField: 1/<Enabled>k__BackingField: 0/' unity-renderer/Assets/Resources/Sentry/SentryOptions.asset
}

export PROJECT_PATH
PROJECT_PATH="$(pwd)/unity-renderer"


ls -lah /root/.cache/unity3d

echo "UNITY PATH is $UNITY_PATH"


set -x
