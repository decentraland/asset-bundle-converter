using AssetBundleConverter.Wrappers.Interfaces;
using UnityEditor;

namespace DCL.ABConverter
{
    /// <summary>
    /// Adapter that implements IAssetBundleManifest by querying the AssetDatabase
    /// for bundle names and dependencies. This allows metadata generation without
    /// a prior BuildAssetBundles call — the AssetDatabase resolves inter-bundle
    /// dependencies from import metadata after SetAssetBundleNameAndVariant has
    /// been called on each asset folder.
    /// </summary>
    public class AssetDatabaseManifest : IAssetBundleManifest
    {
        public string[] GetAllAssetBundles() =>
            AssetDatabase.GetAllAssetBundleNames();

        public string[] GetAllDependencies(string assetBundle) =>
            AssetDatabase.GetAssetBundleDependencies(assetBundle, true);
    }
}
