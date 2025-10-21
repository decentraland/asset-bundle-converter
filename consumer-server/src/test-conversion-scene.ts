// This file is run by the Dockerfile build, it runs a test conversion of
// predefined scene assets to "warmup" the compilation cache of unity and to verify
// the conversion helpers work as expected

import { runTestConversion } from './test-conversion-common'

async function main() {
  await runTestConversion({
    defaultPointer: '43,100',
    runManifestBuilder: true,
    manifestBuilderOutputPath: '../asset-bundle-converter/Assets/_SceneManifest'
  })
}

main().catch((err) => {
  process.exitCode = 1
  console.error(err)
})
