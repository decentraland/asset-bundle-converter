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
        //   [-lodSource catalyst|worlds]   (default: catalyst)
        //   [-lodNetwork org|zone]         (default: org)
        public static async void ExportURLLODsToAssetBundles()
        {
            try
            {
                string[] commandLineArgs = System.Environment.GetCommandLineArgs();

                string customOutputDirectory = "";
                string lodsURL = "";

                if (Utils.ParseOption(commandLineArgs, Config.LODS_URL, 1, out string[] lodsURLArg))
                    lodsURL = lodsURLArg[0];

                if (Utils.ParseOption(commandLineArgs, Config.CLI_SET_CUSTOM_OUTPUT_ROOT_PATH, 1, out string[] outputDirectoryArg))
                    customOutputDirectory = outputDirectoryArg[0] + "/";

                var source = ParseSource(commandLineArgs);
                var network = ParseNetwork(commandLineArgs);
                Debug.Log($"[LOD] Resolved environment: source={source}, network={network}");

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
                var lodConversion = new LODConversion(customOutputDirectory, localPaths.ToArray(), source, network);
                await lodConversion.ConvertLODs();
                EditorApplication.Exit(0);
            }
            catch (Exception e)
            {
                Debug.LogError($"[LOD] ExportURLLODsToAssetBundles failed: {e.Message}\n{e.StackTrace}");
                EditorApplication.Exit(1);
            }
        }

        private static CatalystSource ParseSource(string[] commandLineArgs)
        {
            if (!Utils.ParseOption(commandLineArgs, Config.CLI_LOD_SOURCE, 1, out string[] arg) || arg == null || string.IsNullOrEmpty(arg[0]))
                return CatalystSource.Catalyst;

            string raw = arg[0].Trim();
            if (string.Equals(raw, "worlds", StringComparison.OrdinalIgnoreCase)) return CatalystSource.Worlds;
            if (string.Equals(raw, "catalyst", StringComparison.OrdinalIgnoreCase)) return CatalystSource.Catalyst;

            Debug.LogWarning($"[LOD] Unknown -lodSource value '{raw}', defaulting to Catalyst. Accepted: catalyst|worlds.");
            return CatalystSource.Catalyst;
        }

        private static CatalystNetwork ParseNetwork(string[] commandLineArgs)
        {
            if (!Utils.ParseOption(commandLineArgs, Config.CLI_LOD_NETWORK, 1, out string[] arg) || arg == null || string.IsNullOrEmpty(arg[0]))
                return CatalystNetwork.Org;

            string raw = arg[0].Trim();
            if (string.Equals(raw, "zone", StringComparison.OrdinalIgnoreCase)) return CatalystNetwork.Zone;
            if (string.Equals(raw, "org", StringComparison.OrdinalIgnoreCase)) return CatalystNetwork.Org;

            Debug.LogWarning($"[LOD] Unknown -lodNetwork value '{raw}', defaulting to Org. Accepted: org|zone.");
            return CatalystNetwork.Org;
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
