using AssetBundleConverter.Wrappers.Interfaces;
using Sentry;
using System;

namespace AssetBundleConverter.Wrappers.Implementations.Default
{
    public class ErrorReporter : IErrorReporter
    {
        private bool enabled;

        public void Enable()
        {
            enabled = true;

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

        public void AddDataToScope(Scope scope, ClientSettings settings)
        {
            scope.SetExtra("hash", settings.targetHash);
            scope.SetExtra("pointer", settings.targetPointer);
            scope.SetExtra("baseUrl", settings.baseUrl);
            scope.SetExtra("isWearable", settings.isWearable);
        }

        public void Dispose()
        {
            if (!enabled) return;

            SentrySdk.Flush();
            SentrySdk.EndSession();
        }
    }
}
