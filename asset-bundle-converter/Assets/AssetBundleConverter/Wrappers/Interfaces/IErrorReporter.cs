using Sentry;
using System;

namespace AssetBundleConverter.Wrappers.Interfaces
{
    public interface IErrorReporter : IDisposable
    {
        void ReportError(string message, ClientSettings clientSettings);

        void ReportException(ConversionException exception);

        void AddDataToScope(Scope scope, ClientSettings settings);

        void Enable();
    }
}
