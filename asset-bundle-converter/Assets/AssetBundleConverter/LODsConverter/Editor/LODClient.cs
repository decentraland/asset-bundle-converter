using System;
using System.Collections.Generic;
using System.IO;
using System.Threading.Tasks;
using AssetBundleConverter.LODsConverter.Utils;
using DCL;
using UnityEditor;
using UnityEngine;
using UnityEngine.Networking;

namespace DCL.ABConverter
{
    public class LODClient
    {
        // Used by the consumer-server:
        //   -lods <url1;url2;...> -output <dir>
        //   [-contentServerUrl <url>]   (default: https://peer.decentraland.org/content)
        public static async void ExportURLLODsToAssetBundles()
        {
            try
            {
                string[] commandLineArgs = System.Environment.GetCommandLineArgs();

                string customOutputDirectory = "";
                string lodsURL = "";
                string contentServerUrl = "";

                if (Utils.ParseOption(commandLineArgs, Config.LODS_URL, 1, out string[] lodsURLArg))
                    lodsURL = lodsURLArg[0];

                if (Utils.ParseOption(commandLineArgs, Config.CLI_SET_CUSTOM_OUTPUT_ROOT_PATH, 1, out string[] outputDirectoryArg))
                    customOutputDirectory = outputDirectoryArg[0] + "/";

                if (Utils.ParseOption(commandLineArgs, Config.CLI_CONTENT_SERVER_URL, 1, out string[] contentServerUrlArg)
                    && contentServerUrlArg != null
                    && !string.IsNullOrWhiteSpace(contentServerUrlArg[0]))
                    contentServerUrl = contentServerUrlArg[0].Trim();

                // Emit before any other LOD work so the Unity batch-mode log
                // alone is enough to tell whether the upstream caller passed
                // -contentServerUrl. Pairs with the same line on the consumer-
                // server side ("Starting LOD conversion for … contentServerUrl=…").
                Debug.Log($"[LOD] CLI args parsed. contentServerUrl={(string.IsNullOrEmpty(contentServerUrl) ? "(none, LODConversion will use default)" : contentServerUrl)}, lods={lodsURL}, output={customOutputDirectory}");

                if (string.IsNullOrEmpty(lodsURL))
                {
                    Debug.LogError("[LOD] -lods argument missing or empty.");
                    EditorApplication.Exit(1);
                    return;
                }

                string downloadDir = Path.Combine(Application.dataPath, "_DownloadedGLBs");
                Directory.CreateDirectory(downloadDir);

                var localPaths = new List<string>();
                foreach (string url in lodsURL.Split(';'))
                {
                    string trimmed = url.Trim();
                    if (string.IsNullOrEmpty(trimmed)) continue;

                    string localPath = await DownloadAsync(trimmed, downloadDir);
                    if (!string.IsNullOrEmpty(localPath))
                        localPaths.Add(localPath);
                }

                if (localPaths.Count == 0)
                {
                    Debug.LogError("[LOD] No URLs downloaded successfully.");
                    EditorApplication.Exit(1);
                    return;
                }

                AssetDatabase.Refresh();

                var lodConversion = string.IsNullOrEmpty(contentServerUrl)
                    ? new LODConversion(customOutputDirectory, localPaths.ToArray())
                    : new LODConversion(customOutputDirectory, localPaths.ToArray(), contentServerUrl);
                await lodConversion.ConvertLODs();
                EditorApplication.Exit(0);
            }
            catch (Exception e)
            {
                Debug.LogError($"[LOD] ExportURLLODsToAssetBundles failed: {e.Message}\n{e.StackTrace}");
                EditorApplication.Exit(1);
            }
        }

        private static async Task<string> DownloadAsync(string url, string downloadDir)
        {
            string fileName;
            try { fileName = Path.GetFileName(new Uri(url).LocalPath); }
            catch { fileName = Path.GetFileName(url); }

            if (string.IsNullOrEmpty(fileName))
                fileName = $"download_{DateTime.UtcNow:yyyyMMdd_HHmmss}.glb";
            if (!fileName.EndsWith(".glb", StringComparison.OrdinalIgnoreCase) &&
                !fileName.EndsWith(".gltf", StringComparison.OrdinalIgnoreCase))
                fileName += ".glb";

            string destination = Path.Combine(downloadDir, fileName);
            using (var request = UnityWebRequest.Get(url))
            {
                request.downloadHandler = new DownloadHandlerFile(destination);
                var op = request.SendWebRequest();
                while (!op.isDone) await Task.Yield();

                if (request.result != UnityWebRequest.Result.Success)
                {
                    Debug.LogError($"[LOD] Download failed for {url}: {request.error}");
                    if (File.Exists(destination)) File.Delete(destination);
                    return null;
                }
            }

            Debug.Log($"[LOD] Downloaded: {url} -> {destination}");
            return destination;
        }
    }
}
