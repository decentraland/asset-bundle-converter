using AssetBundleConverter.Wrappers.Interfaces;
using UnityEditor;

namespace DCL.ABConverter
{
    public class AssetDatabaseProvider : IAssetBundleManifest
    {
        public string[] GetAllAssetBundles() =>
            AssetDatabase.GetAllAssetBundleNames();

        //WE dont want it to be recursive. Each asset bundle should only know its direct dependencies
        public string[] GetAllDependencies(string assetBundle) =>
            AssetDatabase.GetAssetBundleDependencies(assetBundle, false);
    }
}
