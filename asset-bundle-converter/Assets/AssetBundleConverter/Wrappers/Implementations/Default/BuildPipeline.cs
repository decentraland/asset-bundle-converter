using AssetBundleConverter;
using AssetBundleConverter.Wrappers.Interfaces;
using UnityEditor;
using UnityEngine;

namespace DCL
{
    public static partial class UnityEditorWrappers
    {
        public class BuildPipeline : IBuildPipeline
        {
            public IAssetBundleManifest BuildAssetBundles(string outputPath, BuildAssetBundleOptions assetBundleOptions, BuildTarget targetPlatform)
            {
                AssetBundleManifest assetBundleManifest = UnityEditor.BuildPipeline.BuildAssetBundles(outputPath, assetBundleOptions, targetPlatform);
                return new AssetBundleManifestWrapper(assetBundleManifest);
            }
        }
    }
}
