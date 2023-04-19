using AssetBundleConverter.Wrappers.Interfaces;
using UnityEngine;

namespace AssetBundleConverter
{
    public class AssetBundleManifestWrapper : IAssetBundleManifest
    {
        private AssetBundleManifest manifest;

        public AssetBundleManifestWrapper(AssetBundleManifest manifest)
        {
            this.manifest = manifest;
        }

        public string[] GetAllAssetBundles() =>
            manifest.GetAllAssetBundles();

        public string[] GetAllDependencies(string assetBundle) =>
            manifest.GetAllDependencies(assetBundle);
    }
}
