import fs from 'fs'
import { dirname } from 'path'

export function ensureUlf() {
  const path = `/root/.local/share/unity3d/Unity/Unity_lic.ulf`
  const hasEnvVar = !!process.env.UNITY_2021_ULF

  if (!fs.existsSync(path)) {
    if (!hasEnvVar) {
      throw new Error('Neither Unity_lic.ulf or env var UNITY_2021_ULF are available')
    } else {
      fs.mkdirSync(dirname(path), { recursive: true })
      fs.writeFileSync(path, process.env.UNITY_2021_ULF!)
    }
  }
}