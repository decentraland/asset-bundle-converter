import { rimraf } from 'rimraf'
import { ILoggerComponent } from '@well-known-components/interfaces'

// Best-effort cleanup of Unity project state left over from a previous
// conversion job. The finally-block cleanup in conversion-task.ts runs after
// every job, but can fail silently (e.g. if the prior Unity process was
// killed while holding a Library/ScriptAssemblies lock). Running the same
// cleanup again at the start of the next job prevents inheriting a
// half-broken project directory.
//
// Never throws: any individual rimraf failure is logged and skipped so a
// single stuck file doesn't prevent other scrub targets from being cleaned.

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
      logger.warn(`Pre-job scrub failed for ${target}: ${err?.message ?? err}`, loggerMetadata as any)
    }
  }
}
