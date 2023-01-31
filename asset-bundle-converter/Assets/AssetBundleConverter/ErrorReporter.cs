using Sentry;
using System;
using UnityEngine;

namespace AssetBundleConverter
{
    public class ErrorReporter : IDisposable
    {
        private readonly bool enabled;

        public ErrorReporter(bool reportErrors)
        {
            enabled = reportErrors;
            if (!enabled) return;

            var sentryOptions = new SentryOptions
            {
                Dsn = "https://f8934b4b4c4c46d4a952681c3afc7fa4@o4504361728212992.ingest.sentry.io/4504492071780352",
            };

            SentrySdk.Init(sentryOptions);
            SentrySdk.StartSession();
        }

        public void ReportError(string message, ClientSettings clientSettings)
        {
            if (!enabled) return;

            SentrySdk.CaptureMessage(message, scope => AddDataToScope(scope, clientSettings), SentryLevel.Error);
        }

        public void ReportException(ConversionException exception)
        {
            if (!enabled) return;

            SentrySdk.CaptureException(exception.originalException, scope => AddDataToScope(scope, exception.settings));
        }

        private void AddDataToScope(Scope scope, ClientSettings settings)
        {
            scope.SetExtra("hash", settings.targetHash);
            scope.SetExtra("pointer", settings.targetPointer);
            scope.SetExtra("topLevelDomain", settings.tld);
            scope.SetExtra("endpoint", settings.endPoint);
        }

        public void Dispose()
        {
            if (!enabled) return;

            SentrySdk.Flush();
            SentrySdk.EndSession();
        }
    }
}
