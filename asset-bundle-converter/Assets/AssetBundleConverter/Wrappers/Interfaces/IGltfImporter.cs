using DCL.ABConverter;
using System.Collections.Generic;

namespace AssetBundleConverter.Wrappers.Interfaces
{
    public interface IGltfImporter
    {
        IGltfImport GetImporter(AssetPath filePath, Dictionary<string, string> contentTable, ShaderType shaderType);

        bool ConfigureImporter(string relativePath, Dictionary<string, string> contentTable, string fileRootPath, string hash, ShaderType shaderType);
    }
}
