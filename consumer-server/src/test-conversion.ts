// This file is run by the Dockerfile build, it runs a test conversion of
// predefined assets to "warmup" the compilation cache of unity and to verify
// the conversion helpers work as expected

import arg from 'arg'
import { createFetchComponent } from './adapters/fetch'

import { getEntities } from './logic/fetch-entity-by-pointer'
import { createLogComponent } from '@well-known-components/logger'
import { IPFSv1, IPFSv2 } from '@dcl/schemas'
import { runConversion } from './logic/run-conversion'
import { spawn } from 'child_process'
import { closeSync, openSync } from 'fs'
import * as promises from 'fs/promises'
import { ensureUlf } from './logic/ensure-ulf'
import { dirname } from 'path'
import { createMetricsComponent } from '@well-known-components/metrics'
import { metricDeclarations } from './metrics'
import { createConfigComponent } from '@well-known-components/env-config-provider'
import { getUnityBuildTarget } from './utils'

const args = arg({
  '--pointer': String,
  '--baseUrl': String,
  '--outDir': String,
  '--logFile': String
})

const BASE_URL = args['--baseUrl'] || 'https://peer.decentraland.org/content'
const POINTER = args['--pointer'] || '0,0'
const OUT_DIRECTORY = args['--outDir']!
const LOG_FILE = args['--logFile']!
const $UNITY_PATH = process.env.UNITY_PATH!
const $PROJECT_PATH = process.env.PROJECT_PATH!
const $BUILD_TARGET = process.env.BUILD_TARGET!

if (!$UNITY_PATH) throw new Error(`UNITY_PATH env var is not defined`)
if (!$PROJECT_PATH) throw new Error(`PROJECT_PATH env var is not defined`)
if (!$BUILD_TARGET) throw new Error(`BUILD_TARGET env var is not defined`)
if (!LOG_FILE) throw new Error(`--logFile was not provided`)
if (!OUT_DIRECTORY) throw new Error(`--outDir was not provided`)

async function main() {
  ensureUlf()

  await promises.mkdir(dirname(LOG_FILE), { recursive: true })
  await promises.mkdir(OUT_DIRECTORY, { recursive: true })

  const fetcher = await createFetchComponent()
  const logs = await createLogComponent({})
  const config = createConfigComponent({})
  const metrics = await createMetricsComponent(metricDeclarations, { config })
  const animation = 'legacy'

  let entityId = ''

  if (IPFSv2.validate(POINTER) || IPFSv1.validate(POINTER)) {
    entityId = POINTER
  } else {
    const entities = await getEntities(fetcher, [POINTER], BASE_URL)
    if (!entities.length) throw new Error(`Cannot find pointer ${POINTER} in server ${BASE_URL}`)
    entityId = entities[0].id
  }

  const logger = logs.getLogger('test-logger')

  // touch
  closeSync(openSync(LOG_FILE, 'w'))

  const child = spawn('tail', ['-f', LOG_FILE])
  child.stdout.pipe(process.stdout)

  const unityBuildTarget = getUnityBuildTarget($BUILD_TARGET)
  if (!unityBuildTarget) {
    logger.info('Invalid build target ' + $BUILD_TARGET)
    return
  }

  try {
    const exitCode = await runConversion(
      logger,
      { metrics },
      {
        logFile: LOG_FILE,
        contentServerUrl: BASE_URL,
        entityId,
        outDirectory: OUT_DIRECTORY,
        unityPath: $UNITY_PATH,
        projectPath: $PROJECT_PATH,
        timeout: 30 * 60 * 1000, // 30min
        unityBuildTarget: unityBuildTarget,
        animation: animation
      }
    )

    if (exitCode) throw new Error('ExitCode=' + exitCode)
  } finally {
    child.kill('SIGKILL')
    child.unref()

    console.dir({ dir: await promises.readdir(OUT_DIRECTORY) })
  }

  process.exit()
}

main().catch((err) => {
  process.exitCode = 1
  console.error(err)
})
