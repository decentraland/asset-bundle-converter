using AssetBundleConverter.Editor;
using AssetBundleConverter.Wrappers.Interfaces;
using DCL;
using DCL.ABConverter;
using GLTFast;
using GLTFast.Logging;
using GLTFast.Materials;
using System;
using System.Collections.Generic;
using UnityEditor;

namespace AssetBundleConverter.Wrappers.Implementations.Default
{
    public class DefaultGltfImporter : IGltfImporter
    {
        private readonly ConsoleLogger gltfLogger = new ();
        private IAssetDatabase assetDatabase;
        private UninterruptedDeferAgent uninterruptedDeferAgent;
        private IMaterialGenerator getNewMaterialGenerator;

        public DefaultGltfImporter(IAssetDatabase assetDatabase)
        {
            uninterruptedDeferAgent = new UninterruptedDeferAgent();
            this.assetDatabase = assetDatabase;
        }

        public IGltfImport GetImporter(AssetPath filePath, Dictionary<string, string> contentTable, ShaderType shaderType, BuildTarget buildTarget)
        {
            if (shaderType != ShaderType.Dcl)
                throw new ArgumentException($"Shader type: {shaderType} cannot be used with this importer, it must be ShaderType.Dcl");

            getNewMaterialGenerator = new AssetBundleConverterMaterialGenerator();

            return new GltfImportWrapper(
                new GltFastFileProvider(filePath.fileRootPath, filePath.hash, contentTable),
                uninterruptedDeferAgent,
                getNewMaterialGenerator,
                gltfLogger);
        }

        public bool ConfigureImporter(string relativePath, ContentMap[] contentMap, string fileRootPath, string hash, ShaderType shaderType,
            AnimationMethod animationMethod)
        {
            var gltfImporter = AssetImporter.GetAtPath(relativePath) as CustomGltfImporter;
            if (gltfImporter != null)
            {
                gltfImporter.SetupCustomFileProvider(contentMap, fileRootPath, hash);

                gltfImporter.useOriginalMaterials = shaderType == ShaderType.GlTFast;
                gltfImporter.importSettings.AnimationMethod = animationMethod;
                gltfImporter.importSettings.GenerateMipMaps = false;

                assetDatabase.SaveImporter(gltfImporter);
                return true;
            }

            return false;
        }
    }
}
