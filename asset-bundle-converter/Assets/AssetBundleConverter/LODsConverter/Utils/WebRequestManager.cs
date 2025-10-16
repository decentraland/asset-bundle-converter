using System.Collections.Generic;
using System.IO;
using System.Threading.Tasks;
using Cysharp.Threading.Tasks;
using Newtonsoft.Json;
using UnityEngine;
using UnityEngine.Networking;

namespace AssetBundleConverter.LODsConverter.Utils
{
    public class WebRequestManager : IWebRequestManager
    {
        public async Task<Parcel> GetParcel(string sceneIDWithLODLevel)
        {
            var decodedParcels = new List<Vector2Int>();

            string hash = sceneIDWithLODLevel.Split('_')[0];
            string url = "https://peer.decentraland.org/content/entities/active/";

            using (var request = UnityWebRequest.Post(url, "{\"ids\":[\"" + hash + "\"]}", "application/json"))
            {
                await request.SendWebRequest();
                if (request.result == UnityWebRequest.Result.Success)
                {
                    string responseText = request.downloadHandler.text;
                    var parcelData = JsonConvert.DeserializeObject<Parcel[]>(responseText);
                    return parcelData[0];

                }
                else
                {
                    Debug.LogError($"Error getting decoded parcels for {hash}");
                    DCL.ABConverter.Utils.Exit(1);
                    return null;
                }
            }
        }

        public async Task<string[]> DownloadAndSaveFiles(string[] lodsURL, string tempDownloadPath)
        {
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
                        Debug.LogError($"Error downloading {url}: {webRequest.error}");
                        DCL.ABConverter.Utils.Exit(1);
                        return null;
                    }
                }
            }

            return  downloadedPaths;
        }
    }
}
