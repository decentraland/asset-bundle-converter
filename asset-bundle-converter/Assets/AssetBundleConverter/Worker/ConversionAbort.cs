using System;

namespace DCL.ABConverter.Worker
{
    // Thrown in place of EditorApplication.Exit when a long-lived worker is
    // serving requests, so a per-conversion failure aborts the in-flight
    // request without killing the Unity process. Caught at the request
    // boundary in RequestRouter (Phase 2); the exit code becomes the response
    // payload.
    public class ConversionAbort : Exception
    {
        public int Code { get; }

        public ConversionAbort(int code) : base($"Conversion aborted with code {code}")
        {
            Code = code;
        }
    }
}
