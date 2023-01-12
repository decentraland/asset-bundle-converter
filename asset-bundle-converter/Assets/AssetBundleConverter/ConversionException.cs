// unset:none
using System;

namespace AssetBundleConverter
{
    public enum ConversionStep
    {
        Fetch,
        Import,
        Convert,
        VisualTest
    }

    public class ConversionException : Exception
    {
        public ClientSettings settings;
        public ConversionStep step;
        public Exception originalException;

        public ConversionException(ConversionStep step, ClientSettings settings, Exception originalException) : base(originalException.Message)
        {
            this.originalException = originalException;
            this.step = step;
            this.settings = settings;
        }
    }
}
