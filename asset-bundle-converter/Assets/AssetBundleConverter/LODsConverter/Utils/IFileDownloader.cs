using System.Threading.Tasks;

namespace AssetBundleConverter.LODsConverter.Utils
{
    public interface IFileDownloader
    {
        Task<string[]> Download();
    }
}