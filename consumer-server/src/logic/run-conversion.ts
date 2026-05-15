import { ILoggerComponent } from '@well-known-components/interfaces'
import { closeSync, openSync } from 'fs'
import * as fs from 'fs/promises'
import { dirname, resolve } from 'path'
import { AppComponents } from '../types'
import { normalizeContentsBaseUrl } from '../utils'
import { execCommand } from './run-command'
import { spawn } from 'child_process'

async function setupStartDirectories(options: { logFile: string; outDirectory: string; projectPath: string }) {
  // touch logfile and create folders
  await fs.mkdir(dirname(options.logFile), { recursive: true })
  await fs.mkdir(options.outDirectory, { recursive: true })
  closeSync(openSync(options.logFile, 'w'))
}

// Strict CID shape — content hashes flowing into Unity CLI flags are
// alphanumeric (Decentraland uses base32-lower CIDv1 and base58 CIDv0,
// both subsets of `[a-zA-Z0-9]`). Reject anything else before joining
// with `;` so a hypothetical compromised catalyst can't inject extra
// separators (or shell metacharacters) into the argv we hand to Unity.
// Pre-existing pattern for `-cachedHashes` had no such guard; this
// helper closes that systemic gap while introducing `-skippedHashes`.
const HASH_SHAPE_RE = /^[a-zA-Z0-9]+$/
function joinValidatedHashes(hashes: ReadonlyArray<string>, flagName: string): string {
  for (const h of hashes) {
    if (!HASH_SHAPE_RE.test(h)) {
      throw new Error(`${flagName} contains a malformed hash ${JSON.stringify(h)} — refusing to forward to Unity`)
    }
  }
  return hashes.join(';')
}

export function startManifestBuilder(sceneId: string, outputPath: string, catalyst: string) {
  const cmd = process.platform === 'win32' ? 'npm.cmd' : 'npm'
  const child = spawn(
    cmd,
    [
      'run',
      'start',
      `--sceneid=${sceneId}`,
      `--output=${outputPath}`,
      `--catalyst=${catalyst}`,
      '--prefix',
      '../scene-lod-entities-manifest-builder'
    ],
    {
      stdio: 'inherit',
      env: process.env
    }
  )

  return new Promise<void>((resolve, reject) => {
    child.on('close', (code) => {
      if (code !== 0) {
        console.error(`scene-lod-entities-manifest-builder exited with ${code}`)
        reject(new Error(`Process exited with code ${code}`))
      } else {
        resolve()
      }
    })
  })
}

async function executeProgram(options: {
  logger: ILoggerComponent.ILogger
  components: Pick<AppComponents, 'metrics'>
  childArg0: string
  childArguments: string[]
  projectPath: string
  timeout: number
}) {
  const { logger, components, childArg0, childArguments, projectPath, timeout } = options
  const { exitPromise, child } = execCommand(logger, childArg0, childArguments, process.env as any, projectPath)

  if (timeout) {
    setTimeout(() => {
      if (exitPromise.isPending) {
        try {
          if (!child.killed) {
            logger.warn('Process did not finish', {
              pid: child.pid?.toString() || '?',
              command: childArg0,
              args: childArguments.join(' ')
            } as any)
            components.metrics.increment('ab_converter_timeout')
            exitPromise.reject(new Error('Process did not finish'))
            if (!child.kill('SIGKILL')) {
              logger.error('Error trying to kill child process', {
                pid: child.pid?.toString() || '?',
                command: childArg0,
                args: childArguments.join(' ')
              } as any)
            }
          }
        } catch (err: any) {
          logger.error(err)
        }
      }
    }, timeout)
  }

  return exitPromise
}

export async function runLodsConversion(
  logger: ILoggerComponent.ILogger,
  components: Pick<AppComponents, 'metrics'>,
  options: {
    logFile: string
    outDirectory: string
    entityId: string
    lods: string[]
    unityPath: string
    projectPath: string
    timeout: number
    unityBuildTarget: string
  }
) {
  await setupStartDirectories(options)

  const childArg0 = `${options.unityPath}/Editor/Unity`

  const childArguments: string[] = [
    '-projectPath',
    options.projectPath,
    '-batchmode',
    '-executeMethod',
    'DCL.ABConverter.LODClient.ExportURLLODsToAssetBundles',
    '-sceneCid',
    options.entityId,
    '-logFile',
    options.logFile,
    '-lods',
    options.lods.join(';'),
    '-output',
    options.outDirectory,
    '-buildTarget',
    options.unityBuildTarget,
    '-deleteDownloadPathAfterFinished'
  ]

  return await executeProgram({
    logger,
    components,
    childArg0,
    childArguments,
    projectPath: options.projectPath,
    timeout: options.timeout
  })
}

export async function runConversion(
  logger: ILoggerComponent.ILogger,
  components: Pick<AppComponents, 'metrics'>,
  options: {
    logFile: string
    outDirectory: string
    entityId: string
    entityType: string
    contentServerUrl: string
    unityPath: string
    projectPath: string
    timeout: number
    unityBuildTarget: string
    animation: string | undefined
    doISS: boolean | undefined
    cachedHashes?: string[]
    /** Content hashes whose glb/gltf bytes the consumer-server determined are
     * unconvertible (missing dependencies / unparseable). Unity drops these
     * from `gltfPaths` and `bufferPaths` before any download or import
     * attempt, so no bundle is produced for them. Distinct from
     * `cachedHashes` which presumes the canonical bundle exists upstream. */
    skippedHashes?: string[]
    depsDigestByHash?: ReadonlyMap<string, string>
  }
) {
  await setupStartDirectories(options)

  // Run manifest builder before conversion if needed
  if (options.entityType === 'scene' && options.unityBuildTarget !== 'WebGL' && options.doISS) {
    try {
      const catalystDomain = new URL(options.contentServerUrl).origin
      await startManifestBuilder(options.entityId, options.projectPath + '/Assets/_SceneManifest', catalystDomain)
    } catch (e) {
      logger.error('Failed to generate scene manifest, building without ISS')
    }
  }

  const contentServerUrl = normalizeContentsBaseUrl(options.contentServerUrl)

  const childArg0 = `${options.unityPath}/Editor/Unity`

  const childArguments: string[] = [
    '-projectPath',
    options.projectPath,
    '-batchmode',
    '-executeMethod',
    'DCL.ABConverter.SceneClient.ExportSceneToAssetBundles',
    '-sceneCid',
    options.entityId,
    '-logFile',
    options.logFile,
    '-baseUrl',
    contentServerUrl,
    '-output',
    options.outDirectory,
    '-buildTarget',
    options.unityBuildTarget,
    '-animation',
    options.animation || 'legacy'
  ]

  if (options.cachedHashes && options.cachedHashes.length > 0) {
    childArguments.push('-cachedHashes', joinValidatedHashes(options.cachedHashes, 'cachedHashes'))
  }

  if (options.skippedHashes && options.skippedHashes.length > 0) {
    childArguments.push('-skippedHashes', joinValidatedHashes(options.skippedHashes, 'skippedHashes'))
  }

  // Per-asset deps digests go out via a temp JSON file rather than an inline
  // CLI arg: a scene with dozens of glbs × 96 chars per entry would push the
  // arg string close to argv limits and fight shell-escaping on Windows. Unity
  // reads the file in `ParseCommonSettings`.
  //
  // The file is written ADJACENT to outDirectory (not inside it) so that even
  // if our best-effort unlink in the finally below fails, the orphan can't be
  // picked up by `readdir(outDirectory)` in conversion-task.ts (it'd land in
  // the entity manifest) or by `uploadDir`'s `**/*` match (it'd land at
  // `{AB_VERSION}/assets/deps-digests.json` on S3).
  //
  // `path.resolve` normalizes any trailing slashes — otherwise
  // `"/tmp/entity_X/" + ".deps-digests.json"` would land *inside* the
  // directory and silently reintroduce the leak class this guards against.
  //
  // The path is decided before the try so the finally can clean up regardless
  // of whether writeFile succeeded, partially succeeded (disk full mid-write),
  // or threw before creating the file — fs.unlink swallows ENOENT for us.
  const depsDigestsFile =
    options.depsDigestByHash && options.depsDigestByHash.size > 0
      ? `${resolve(options.outDirectory)}.deps-digests.json`
      : undefined

  try {
    if (depsDigestsFile && options.depsDigestByHash) {
      const payload: Record<string, string> = {}
      for (const [hash, digest] of options.depsDigestByHash) payload[hash] = digest
      await fs.writeFile(depsDigestsFile, JSON.stringify(payload), 'utf8')
      childArguments.push('-depsDigestsFile', depsDigestsFile)
    }

    return await executeProgram({
      logger,
      components,
      childArg0,
      childArguments,
      projectPath: options.projectPath,
      timeout: options.timeout
    })
  } finally {
    if (depsDigestsFile) {
      // Best-effort — the outer teardown will also rimraf `outDirectory`, so
      // failing here is harmless. Runs even when writeFile crashed mid-write
      // so a half-written sidecar can't leak past the process.
      try {
        await fs.unlink(depsDigestsFile)
      } catch {}
    }
  }
}
