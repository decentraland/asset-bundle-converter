using AssetBundleConverter.Wrappers.Interfaces;
using UnityEditor;

namespace DCL
{
    public interface IBuildPipeline
    {
        IAssetBundleManifest BuildAssetBundles(
            string outputPath,
            BuildAssetBundleOptions assetBundleOptions,
            BuildTarget targetPlatform);
    }
}
