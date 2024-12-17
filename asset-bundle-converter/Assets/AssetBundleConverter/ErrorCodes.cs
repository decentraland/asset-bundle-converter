namespace DCL.ABConverter
{
    /// <summary>
    /// For consistency, never remove any of these enum values as it will break old error codes
    /// </summary>
    public enum ErrorCodes
    {
        SUCCESS,
        UNDEFINED,
        SCENE_LIST_NULL,
        ASSET_BUNDLE_BUILD_FAIL,
        VISUAL_TEST_FAILED,
        UNEXPECTED_ERROR,
        GLTFAST_CRITICAL_ERROR,
        GLTF_IMPORTER_NOT_FOUND,
        EMBED_MATERIAL_FAILURE,
        DOWNLOAD_FAILED,
        INVALID_PLATFORM,
        GLTF_PROCESS_MISMATCH,
        CONVERSION_ERRORS_TOLERATED,
        ALREADY_CONVERTED
    }
}
