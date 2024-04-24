using System.Collections.Generic;
using System.Threading.Tasks;
using UnityEngine;

namespace AssetBundleConverter.LODsConverter.Utils
{
    public interface IWebRequestManager
    {
        Task<string[]> DownloadAndSaveFiles(string[] lodsURL, string tempDownloadPath);

        Task<Parcel> GetParcel(string sceneID);
    }
}