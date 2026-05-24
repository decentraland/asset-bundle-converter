namespace DCL.ABConverter.Worker
{
    public static class WorkerServer
    {
        // Phase 1 stub: stays false until Phase 2 wires up the long-lived
        // request-loop entry method. While false, Utils.Exit / ForceExit keep
        // their existing batch-mode-kills-the-process semantics — the refactor
        // is a no-op at runtime.
        public static bool IsActive;
    }
}
