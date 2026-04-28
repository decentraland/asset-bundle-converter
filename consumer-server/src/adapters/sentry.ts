import * as Sentry from '@sentry/node'
import { AppComponents } from '../types'
import type { CaptureContext, SeverityLevel } from '@sentry/types'

export type SentryComponent = {
  captureMessage: (message: string, captureContext?: CaptureContext | SeverityLevel) => void
  captureException: (error: unknown, captureContext?: CaptureContext) => void
}

export async function createSentryComponent({ config }: Pick<AppComponents, 'config'>) {
  const environment = await config.getString('ENV')
  const sentryDsn = await config.getString('SENTRY_DSN')

  if (sentryDsn) {
    Sentry.init({
      environment: environment === 'prd' ? 'production' : environment || 'unknown',
      dsn: sentryDsn
    })
  }

  function captureMessage(message: string, captureContext?: CaptureContext | SeverityLevel) {
    if (sentryDsn) {
      Sentry.captureMessage(message, captureContext)
    }
  }

  function captureException(error: unknown, captureContext?: CaptureContext) {
    if (sentryDsn) {
      Sentry.captureException(error, captureContext)
    }
  }

  return {
    captureMessage,
    captureException
  }
}
