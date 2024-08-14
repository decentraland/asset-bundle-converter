import fs from 'fs'
import { dirname } from 'path'

// this function ensures that the license file for unity exists. if not, it tries
// to create it using environment variables. otherwise it fails
export function ensureUlf() {
  const path = `/root/.local/share/unity3d/Unity/Unity_lic.ulf`
  const envVarValue = fromB64(process.env.UNITY_2021_ULF_B64) ?? process.env.UNITY_2021_ULF

  if (!fs.existsSync(path) || !fs.statSync(path).size) {
    if (!envVarValue) {
      throw new Error('Neither Unity_lic.ulf or env var UNITY_2021_ULF are available')
    } else {
      console.log(`Writing file ${path}`)
      fs.mkdirSync(dirname(path), { recursive: true })
      try {
        fs.unlinkSync(path)
      } catch {}
      fs.writeFileSync(path, envVarValue)
    }
  } else {
    console.log(`License ${path} exists`)
  }
}

function fromB64(text: string | undefined): string | undefined {
  if (text) {
    return Buffer.from(text, 'base64').toString()
  }
  return undefined
}
