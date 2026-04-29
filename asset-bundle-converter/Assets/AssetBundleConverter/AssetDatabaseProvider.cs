using AssetBundleConverter.Wrappers.Interfaces;
using UnityEditor;

namespace DCL.ABConverter
{
    public class AssetDatabaseProvider : IAssetBundleManifest
    {
        public string[] GetAllAssetBundles() =>
            AssetDatabase.GetAllAssetBundleNames();

        // false = direct deps only; transitive deps are walked by the runtime
        // loader, so including them here would produce redundant entries.
        public string[] GetAllDependencies(string assetBundle) =>
            AssetDatabase.GetAssetBundleDependencies(assetBundle, false);
    }
}
