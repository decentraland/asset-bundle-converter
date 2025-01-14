import * as Sentry from '@sentry/node'
import { AppComponents } from '../types'
import type { CaptureContext, SeverityLevel } from '@sentry/types'

export type SentryComponent = {
  captureMessage: (message: string, captureContext?: CaptureContext | SeverityLevel) => void
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

  async function captureMessage(message: string) {
    if (sentryDsn) {
      Sentry.captureMessage(message)
    }
  }

  return {
    captureMessage
  }
}
