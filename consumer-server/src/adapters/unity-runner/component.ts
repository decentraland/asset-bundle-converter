import { ILoggerComponent } from '@well-known-components/interfaces'
import { closeSync, openSync } from 'fs'
import * as fs from 'fs/promises'
import { dirname, resolve } from 'path'
import { spawn } from 'child_process'
import { future } from 'fp-future'
import type { AppComponents } from '../../types'
import { normalizeContentsBaseUrl } from '../../utils'
import type { IUnityRunnerComponent, RunConversionOptions, RunLodsConversionOptions } from './types'

const HASH_SHAPE_RE = /^[a-zA-Z0-9]+$/

/**
 * Joins content hashes with `;` after validating each one matches the
 * strict CID shape. Decentraland CIDs are base32-lower CIDv1 or base58
 * CIDv0 — both subsets of `[a-zA-Z0-9]`. Rejecting anything else closes
 * the door on a hypothetical compromised catalyst injecting extra
 * separators (or shell metacharacters) into the argv we hand to Unity.
 *
 * @param hashes - Content hashes to join.
 * @param flagName - Name of the CLI flag these hashes back. Surfaces in
 *   the error message so a thrown validation failure points at the
 *   offending field (`cachedHashes` vs `skippedHashes`).
 * @throws when any hash contains characters outside `[a-zA-Z0-9]`.
 */
function joinValidatedHashes(hashes: ReadonlyArray<string>, flagName: string): string {
  for (const h of hashes) {
    if (!HASH_SHAPE_RE.test(h)) {
      throw new Error(`${flagName} contains a malformed hash ${JSON.stringify(h)} — refusing to forward to Unity`)
    }
  }
  return hashes.join(';')
}

/**
 * Ensures the log file's parent directory and the output directory exist,
 * and truncates the log file (touch). Called by both `runConversion` and
 * `runLodsConversion` before the Unity child process is spawned so the
 * `-logFile` flag points at a writable, fresh path.
 */
async function setupStartDirectories(options: { logFile: string; outDirectory: string; projectPath: string }) {
  await fs.mkdir(dirname(options.logFile), { recursive: true })
  await fs.mkdir(options.outDirectory, { recursive: true })
  closeSync(openSync(options.logFile, 'w'))
}

/**
 * Spawn a child process and stream stdout/stderr into the logger.
 *
 * @returns A future that resolves with the exit code (defaulting to -1 if
 *   the child exited without one) and the spawned `ChildProcess` so the
 *   caller can attach a timeout that calls `child.kill('SIGKILL')`.
 *   Rejects when the child terminates via SIGTERM/SIGKILL or fails to
 *   spawn.
 */
function execCommand(
  logger: ILoggerComponent.ILogger,
  command: string,
  args: string[],
  env: Record<string, string>,
  cwd: string
) {
  const exitFuture = future<number>()

  logger.debug('Running command', { command, args } as any)

  const child = spawn(command, args, { env, cwd })
    .on('exit', (code, signal) => {
      logger.info('Command exited', { code, signal } as any)
      if (signal === 'SIGTERM' || signal === 'SIGKILL') {
        exitFuture.reject(new Error('SIGTERM sent to the process'))
      } else {
        exitFuture.resolve(code ?? -1)
      }
    })
    .on('error', (error) => {
      logger.error(error)
      exitFuture.reject(error)
    })

  child.stdout?.on('data', (data) => {
    logger.log(data)
  })

  child.stderr?.on('data', (data) => logger.error(data))

  return { exitPromise: exitFuture, child }
}

/**
 * Spawns the scene-LOD-entities-manifest-builder npm script before the
 * main Unity build kicks off. Invoked only by `runConversion` for ISS
 * scenes (doISS=true on a non-WebGL target). Failures are non-fatal —
 * the caller catches and proceeds with the conversion sans manifest.
 *
 * @param sceneId - Scene CID forwarded as `--sceneid`.
 * @param outputPath - Where the manifest should land; passed as
 *   `--output`.
 * @param catalyst - Catalyst origin (e.g., `https://peer.decentraland.org`)
 *   passed as `--catalyst`.
 * @throws when the child exits with a non-zero status code.
 */
function startManifestBuilder(sceneId: string, outputPath: string, catalyst: string): Promise<void> {
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

  return new Promise<void>((resolveP, reject) => {
    child.on('close', (code) => {
      if (code !== 0) {
        console.error(`scene-lod-entities-manifest-builder exited with ${code}`)
        reject(new Error(`Process exited with code ${code}`))
      } else {
        resolveP()
      }
    })
  })
}

/**
 * Builds the `IUnityRunnerComponent`. Owns the `unity-runner` logger so
 * spawn-related log lines are uniformly attributable, and the
 * `ab_converter_timeout` metric so dashboards count Unity stalls
 * regardless of which method (`runConversion` / `runLodsConversion`)
 * triggered them.
 */
export async function createUnityRunnerComponent(
  components: Pick<AppComponents, 'logs' | 'metrics'>
): Promise<IUnityRunnerComponent> {
  const { logs, metrics } = components
  const logger = logs.getLogger('unity-runner')

  /**
   * Spawns a Unity child via `execCommand` and arms a watchdog that
   * SIGKILLs the process if the conversion exceeds `timeout` ms.
   * Increments `ab_converter_timeout` on the kill path so a slow Unity
   * run is visible to operators.
   */
  async function executeProgram(opts: {
    childArg0: string
    childArguments: string[]
    projectPath: string
    timeout: number
  }): Promise<number> {
    const { childArg0, childArguments, projectPath, timeout } = opts
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
              metrics.increment('ab_converter_timeout')
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

  /**
   * Spawns Unity for a scene / wearable / emote conversion. Touches the
   * log file and output directory first; for ISS scenes on non-WebGL
   * targets, runs the LOD entities manifest builder before the main
   * Unity invocation (failure non-fatal, conversion proceeds).
   *
   * Per-asset deps digests are passed via a sidecar JSON file rather
   * than inline argv — see the comment near `depsDigestsFile` for the
   * rationale (argv length limits + Windows shell-escaping).
   */
  async function runConversion(options: RunConversionOptions): Promise<number> {
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
    // arg string close to argv limits and fight shell-escaping on Windows.
    // Unity reads the file in `ParseCommonSettings`.
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

  /**
   * Spawns Unity for a LOD conversion. Distinct from `runConversion`:
   * uses the `ExportURLLODsToAssetBundles` execute method, takes a
   * `lods` URL list (semicolon-joined) instead of a `contentServerUrl`,
   * and always passes `-deleteDownloadPathAfterFinished` (LODs don't
   * benefit from cache retention between runs).
   */
  async function runLodsConversion(options: RunLodsConversionOptions): Promise<number> {
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

    if (options.contentServerUrl) {
      childArguments.push('-contentServerUrl', options.contentServerUrl)
    }

    return await executeProgram({
      childArg0,
      childArguments,
      projectPath: options.projectPath,
      timeout: options.timeout
    })
  }

  return { runConversion, runLodsConversion }
}
