using UnityEngine;

namespace DCL
{
    public class ABLogger : IABLogger
    {
        public readonly ILogger unityLogger = Debug.unityLogger;
        public bool verboseEnabled { get; set; }

        private string tag;

        public ABLogger(string tag) { this.tag = tag; }

        public void Verbose(string message, Object context = null)
        {
            if (!verboseEnabled)
                return;

            unityLogger.Log(LogType.Log, tag, message, context);
        }

        public void Info(string message, Object context = null) { unityLogger.Log(LogType.Log, tag, message, context); }

        public void Error(string message, Object context = null) { unityLogger.Log(LogType.Error, tag, message, context); }

        public void Warning(string message, Object context = null) { unityLogger.Log(LogType.Warning, tag, message, context); }

        public void Exception(string message, Object context = null) { unityLogger.Log(LogType.Exception, tag, message, context); }

    }

    public interface IABLogger
    {
        void Verbose(string message, Object context = null);

        void Info(string message, Object context = null);

        void Error(string message, Object context = null);

        void Warning(string message, Object context = null);

        void Exception(string message, Object context = null);

        bool verboseEnabled { get; set; }
    }
}
