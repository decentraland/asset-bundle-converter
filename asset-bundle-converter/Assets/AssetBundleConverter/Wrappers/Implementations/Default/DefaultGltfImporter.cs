
using AssetBundleConverter.Editor;
using AssetBundleConverter.Wrappers.Interfaces;
using DCL;
using DCL.ABConverter;
using GLTFast;
using GLTFast.Logging;
using GLTFast.Materials;
using System.Collections.Generic;
using System.Linq;
using UnityEditor;
using UnityEngine;

namespace AssetBundleConverter.Wrappers.Implementations.Default
{
    public class DefaultGltfImporter : IGltfImporter
    {
        private readonly ConsoleLogger gltfLogger = new ();
        private IAssetDatabase assetDatabase;

        public DefaultGltfImporter(IAssetDatabase assetDatabase)
        {
            this.assetDatabase = assetDatabase;
        }

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

        public bool ConfigureImporter(string relativePath, Dictionary<string, string> contentTable, string fileRootPath, string hash, ShaderType shaderType )
        {
            var gltfImporter = AssetImporter.GetAtPath(relativePath) as CustomGltfImporter;
            if (gltfImporter != null)
            {
                ContentMap[] contentMap = contentTable.Select(kvp => new ContentMap(kvp.Key, kvp.Value)).ToArray();
                gltfImporter.SetupCustomFileProvider(contentMap, fileRootPath, hash);

                gltfImporter.useOriginalMaterials = shaderType == ShaderType.GlTFast;
                gltfImporter.importSettings.AnimationMethod = AnimationMethod.Legacy;
                gltfImporter.importSettings.GenerateMipMaps = false;

                assetDatabase.SaveImporter(gltfImporter);
                return true;
            }

            return false;
        }
    }
}
