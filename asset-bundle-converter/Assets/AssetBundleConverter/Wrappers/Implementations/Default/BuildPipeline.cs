using AssetBundleConverter;
using AssetBundleConverter.Wrappers.Interfaces;
using UnityEditor;
using UnityEditor.Build.Content;
using UnityEngine;

namespace DCL
{
    public static partial class UnityEditorWrappers
    {
        public class BuildPipeline : IBuildPipeline
        {
            public IAssetBundleManifest BuildAssetBundles(string outputPath, BuildAssetBundleOptions assetBundleOptions, BuildTarget targetPlatform)
            {
                var builds = ContentBuildInterface.GenerateAssetBundleBuilds();
                AssetBundleManifest assetBundleManifest = UnityEditor.BuildPipeline.BuildAssetBundles(outputPath, builds, assetBundleOptions, targetPlatform);
                return new AssetBundleManifestWrapper(assetBundleManifest);
            }
        }
    }
}
