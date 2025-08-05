export function getUnityBuildTarget(target: string): string | undefined {
  switch (target) {
    case "webgl":
      return "WebGL"
    case "windows":
      return "StandaloneWindows64"
    case "mac":
      return "StandaloneOSX"
    default:
      return undefined
  }
}

export function getAbVersionEnvName(buildTarget: string) {
  switch (buildTarget) {
    case "webgl":
      return "AB_VERSION"
    case "windows":
      return "AB_VERSION_WINDOWS"
    case "mac":
      return "AB_VERSION_MAC"
    default:
      throw "Invalid buildTarget"
  }
}
