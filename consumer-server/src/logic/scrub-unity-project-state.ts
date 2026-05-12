import { rimraf } from 'rimraf'
import { ILoggerComponent } from '@well-known-components/interfaces'

// Best-effort cleanup of Unity project state that's not tied to a specific
// job (Library cache, downloaded assets, scene manifest). Called at both the
// start and the end of each conversion so a silently-failed end-of-job
// cleanup doesn't leave the next job to inherit a half-broken project
// directory (e.g. a Library/ScriptAssemblies lock from an orphan Unity
// process).
//
// Never throws: each rimraf failure is logged and skipped so a single stuck
// target doesn't prevent the rest from being cleaned.

const SCRUB_TARGETS = ['Library', 'Assets/_Downloaded', 'Assets/_SceneManifest'] as const

export async function scrubUnityProjectState(
  projectPath: string,
  logger: ILoggerComponent.ILogger,
  loggerMetadata: Record<string, unknown>
): Promise<void> {
  for (const relative of SCRUB_TARGETS) {
    const target = `${projectPath}/${relative}`
    try {
      await rimraf(target, { maxRetries: 3 })
    } catch (err: any) {
      logger.warn(`Unity project scrub failed for ${target}: ${err?.message ?? err}`, loggerMetadata as any)
    }
  }
}
