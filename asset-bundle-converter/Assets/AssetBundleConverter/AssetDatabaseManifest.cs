using UnityEditor;

namespace DCL.ABConverter
{
    /// <summary>
    /// Queries the AssetDatabase for bundle names and dependencies without
    /// building. The AssetDatabase resolves inter-bundle dependencies from
    /// import metadata after SetAssetBundleNameAndVariant has been called
    /// on each asset folder.
    /// </summary>
    public class AssetDatabaseManifest
    {
        public string[] GetAllAssetBundles() =>
            AssetDatabase.GetAllAssetBundleNames();

        public string[] GetAllDependencies(string assetBundle) =>
            AssetDatabase.GetAssetBundleDependencies(assetBundle, true);
    }
}
