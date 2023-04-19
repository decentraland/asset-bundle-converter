namespace AssetBundleConverter.Wrappers.Interfaces
{
    public interface IAssetBundleManifest
    {
        string[] GetAllAssetBundles();

        string[] GetAllDependencies(string assetBundle);
    }
}
