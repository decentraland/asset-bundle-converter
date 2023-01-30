// This file is run by the Dockerfile build, it runs a test conversion of
// predefined assets to "warmup" the compilation cache of unity and to verify
// the conversion helpers work as expected

import arg from 'arg'
import { createFetchComponent } from './adapters/fetch'

import { getEntities } from './logic/fetch-entity-by-pointer'
import { createLogComponent } from '@well-known-components/logger'
import { runConversion } from './logic/run-conversion'

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

if (!$UNITY_PATH) throw new Error(`UNITY_PATH env var is not defined`)
if (!$PROJECT_PATH) throw new Error(`PROJECT_PATH env var is not defined`)
if (!LOG_FILE) throw new Error(`--logFile was not provided`)
if (!OUT_DIRECTORY) throw new Error(`--outDir was not provided`)

async function main() {
  const fetcher = await createFetchComponent()
  const logs = await createLogComponent({})
  const entities = await getEntities(fetcher, [POINTER], BASE_URL)

  if (!entities.length) throw new Error(`Cannot find pointer ${POINTER} in server ${BASE_URL}`)

  const logger = logs.getLogger('test-logger')

  const exitCode = await runConversion(logger, {
    logFile: LOG_FILE,
    contentServerUrl: BASE_URL,
    entityId: entities[0].id,
    outDirectory: OUT_DIRECTORY,
    unityPath: $UNITY_PATH,
    projectPath: $PROJECT_PATH

  })

  if (exitCode) throw new Error('ExitCode=' + exitCode)
}

main().catch(err => {
  process.exitCode = 1
  console.error(err)
})