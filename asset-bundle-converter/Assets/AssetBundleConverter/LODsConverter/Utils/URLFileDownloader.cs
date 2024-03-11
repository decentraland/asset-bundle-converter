using System.IO;
using System.Threading.Tasks;
using Cysharp.Threading.Tasks;
using UnityEngine;
using UnityEngine.Networking;

namespace AssetBundleConverter.LODsConverter.Utils
{
    public class URLFileDownloader : IFileDownloader
    {
        private readonly string[] lodsURL;
        private readonly string tempDownloadPath;

        public URLFileDownloader(string[] lodsURL, string tempDownloadPath)
        {
            this.lodsURL = lodsURL;
            this.tempDownloadPath = tempDownloadPath;
        }

        public async Task<string[]> Download()
        {
            Directory.CreateDirectory(tempDownloadPath);
            string[] downloadedPaths = new string[lodsURL.Length];
            for (int index = 0; index < lodsURL.Length; index++)
            {
                string url = lodsURL[index];
                using (var webRequest = UnityWebRequest.Get(url))
                {
                    string fileName = Path.GetFileName(url);
                    string savePath = Path.Combine(tempDownloadPath, fileName);
                    Debug.Log($"Starting file download {url}");
                    await webRequest.SendWebRequest();

                    if (webRequest.result == UnityWebRequest.Result.Success)
                    {
                        // Success, save the downloaded file
                        File.WriteAllBytes(savePath, webRequest.downloadHandler.data);
                        Debug.Log($"File downloaded and saved to {savePath}");
                        downloadedPaths[index] = savePath;
                    }
                    else
                    {
                        DCL.ABConverter.Utils.Exit(1);
                        Debug.LogError($"Error downloading {url}: {webRequest.error}");
                        return null;
                    }
                }
            }

            return  downloadedPaths;
        }
    }
}