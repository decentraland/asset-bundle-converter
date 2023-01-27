// This file is run by the Dockerfile build, it runs a test conversion of
// predefined assets to "warmup" the compilation cache of unity and to verify
// the conversion helpers work as expected

import arg from 'arg'
import { createFetchComponent } from './adapters/fetch'
import * as fs from 'fs/promises'
import { getEntities } from './logic/fetch-entity-by-pointer'
import { createLogComponent } from '@well-known-components/logger'
import { execCommand } from './logic/run-command'

const args = arg({
  '--pointer': String,
  '--baseUrl': String,
  '--outDir': String,
  '--logFile': String,
})

const BASE_URL = args['--baseUrl'] || 'https://peer.decentraland.org/content'
const POINTER = args['--pointer'] || '0,0'
const OUT_DIRECTORY = args['--outDir']!
const LOG_FILE = args['--logFile']!
const $UNITY_PATH = process.env.UNITY_PATH!
const $PROJECT_PATH = process.env.PROJECT_PATH!

if (!LOG_FILE) throw new Error(`--logFile was not provided`)
if (!OUT_DIRECTORY) throw new Error(`--outDir was not provided`)
if (!$UNITY_PATH) throw new Error(`UNITY_PATH env var is not defined`)
if (!$PROJECT_PATH) throw new Error(`PROJECT_PATH env var is not defined`)

async function main() {
  const fetcher = await createFetchComponent()
  const logs = await createLogComponent({})
  const entities = await getEntities(fetcher, [POINTER], BASE_URL)

  if (!entities.length) throw new Error(`Cannot find pointer ${POINTER} in server ${BASE_URL}`)

  await fs.mkdir(OUT_DIRECTORY, {recursive: true})
  
  const childArg0 = 'xvfb-run'
  const childArguments: string[] = [
    '--auto-servernum', "--server-args='-screen 0 640x480x24'", `${$UNITY_PATH}/Editor/Unity`,
    '-projectPath', $PROJECT_PATH,
    '-batchmode',
    '-executeMethod', 'DCL.ABConverter.SceneClient.ExportSceneToAssetBundles',
    '-sceneCid', entities[0].id,
    '-logFile', LOG_FILE,
    '-baseUrl', BASE_URL,
    '-output', OUT_DIRECTORY
  ]

  const { exitPromise } = await execCommand({logs}, childArg0, childArguments, entities[0].id, process.env as any, $PROJECT_PATH)

  const exitCode = await exitPromise

  if(exitCode) throw new Error('ExitCode=' + exitCode)
}

main().catch(err => {
  process.exitCode = 1
  console.error(err)
})