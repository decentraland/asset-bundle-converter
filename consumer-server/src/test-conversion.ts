// This file is run by the Dockerfile build, it runs a test conversion of
// predefined wearable assets to "warmup" the compilation cache of unity and to verify
// the conversion helpers work as expected

import { runTestConversion } from './test-conversion-common'

async function main() {
  await runTestConversion({
    defaultPointer: '0,0',
    runManifestBuilder: false
  })
}

main().catch((err) => {
  process.exitCode = 1
  console.error(err)
})
