
using AssetBundleConverter.Wrappers.Interfaces;
using DCL.ABConverter;
using GLTFast;
using GLTFast.Logging;
using GLTFast.Materials;
using System.Collections.Generic;

namespace AssetBundleConverter.Wrappers.Implementations.Default
{
    public class DefaultGltfImporter : IGltfImporter
    {
        private readonly ConsoleLogger gltfLogger = new ();

        public IGltfImport GetImporter(AssetPath filePath, Dictionary<string, string> contentTable, ShaderType shaderType) =>
            new GltfImportWrapper(
                new GltFastFileProvider(filePath.fileRootPath, filePath.hash, contentTable),
                new UninterruptedDeferAgent(),
                GetNewMaterialGenerator(shaderType),
                gltfLogger);

        private IMaterialGenerator GetNewMaterialGenerator(ShaderType shaderType)
        {
            if (shaderType == ShaderType.Dcl)
                return new AssetBundleConverterMaterialGenerator();

            return null;
        }
    }
}
