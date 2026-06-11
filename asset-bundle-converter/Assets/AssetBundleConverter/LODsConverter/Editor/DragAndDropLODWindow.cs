using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using AssetBundleConverter.LODsConverter.Utils;
using UnityEditor;
using UnityEngine;
using UnityEngine.Networking;
using Object = UnityEngine.Object;

public class DragAndDropLODWindow : EditorWindow
{
    private const string DOWNLOAD_FOLDER = "Assets/_DownloadedGLBs";
    private const string SUGGESTED_URL = "https://lod-unity-bucket-dev-0871c25.s3.us-east-1.amazonaws.com/lods-unity/lods/bafkreierdpwiqnuxftmd6xiibgrvxnwzpsgid6jb2cj2l4ayhvv3g7rtai_1.glb";

    private static readonly string[] SOURCE_LABELS = { "Catalyst", "Worlds" };
    private static readonly string[] NETWORK_LABELS = { "Org", "Zone" };

    private readonly List<Object> glbFiles = new ();
    private string urlInput = SUGGESTED_URL;
    private string urlStatus = "";
    private bool isDownloading;
    private int sourceIndex; // 0 = Catalyst, 1 = Worlds
    private int networkIndex; // 0 = Org, 1 = Zone

    [MenuItem("Decentraland/LOD/Build GLB Asset Bundles")]
    public static void Open()
    {
        var window = GetWindow<DragAndDropLODWindow>("GLB → Asset Bundle");
        window.Show();
    }

    private void OnGUI()
    {
        GUILayout.Label("Add GLBs to build as Asset Bundles", EditorStyles.boldLabel);

        GUILayout.Space(4);
        GUILayout.Label("Content source", EditorStyles.miniBoldLabel);
        sourceIndex = EditorGUILayout.Popup("Source", sourceIndex, SOURCE_LABELS);
        networkIndex = EditorGUILayout.Popup("Network", networkIndex, NETWORK_LABELS);
        EditorGUILayout.LabelField("Endpoint", BuildContentServerUrl(), EditorStyles.miniLabel);

        GUILayout.Space(8);
        GUILayout.Label("Download from URL", EditorStyles.miniBoldLabel);
        EditorGUILayout.BeginHorizontal();
        urlInput = EditorGUILayout.TextField(urlInput);
        GUI.enabled = !isDownloading && !string.IsNullOrWhiteSpace(urlInput);
        if (GUILayout.Button(isDownloading ? "Downloading..." : "Download & Add", GUILayout.Width(140)))
            DownloadAndAdd(urlInput.Trim());
        GUI.enabled = true;
        EditorGUILayout.EndHorizontal();
        if (!string.IsNullOrEmpty(urlStatus))
            EditorGUILayout.HelpBox(urlStatus, MessageType.Info);

        GUILayout.Space(8);

        var dropArea = GUILayoutUtility.GetRect(0, 100, GUILayout.ExpandWidth(true));
        GUI.Box(dropArea, "Drop GLB files here", EditorStyles.helpBox);

        var evt = Event.current;

        if (evt.type == EventType.DragUpdated || evt.type == EventType.DragPerform)
        {
            if (dropArea.Contains(evt.mousePosition))
            {
                DragAndDrop.visualMode = DragAndDropVisualMode.Copy;

                if (evt.type == EventType.DragPerform)
                {
                    DragAndDrop.AcceptDrag();

                    foreach (var obj in DragAndDrop.objectReferences)
                    {
                        string path = AssetDatabase.GetAssetPath(obj);

                        if (!path.EndsWith(".glb", StringComparison.OrdinalIgnoreCase) &&
                            !path.EndsWith(".gltf", StringComparison.OrdinalIgnoreCase))
                            continue;

                        if (!glbFiles.Contains(obj))
                            glbFiles.Add(obj);
                    }

                    evt.Use();
                }
            }
        }

        GUILayout.Space(10);
        GUILayout.Label("GLB Files:");
        for (int i = 0; i < glbFiles.Count; i++)
        {
            EditorGUILayout.BeginHorizontal();
            glbFiles[i] = EditorGUILayout.ObjectField(glbFiles[i], typeof(Object), false);

            if (GUILayout.Button("Remove", GUILayout.Width(60)))
            {
                glbFiles.RemoveAt(i);
            }

            EditorGUILayout.EndHorizontal();
        }

        GUILayout.Space(10);

        if (glbFiles.Count > 0 && GUILayout.Button("Clear All"))
        {
            glbFiles.Clear();
        }

        if (GUILayout.Button("Build Asset Bundles"))
        {
            var paths = glbFiles.Select(f =>
                {
                    string assetPath = AssetDatabase.GetAssetPath(f);
                    return Path.Combine(Application.dataPath, assetPath["Assets/".Length..]);
                })
                .ToList();

            Debug.Log($"[LOD] Build button clicked with {paths.Count} GLBs");
            foreach (var p in paths) Debug.Log($"[LOD]   {p}");

            RunConversion(paths);
        }
    }

    private async void RunConversion(List<string> paths)
    {
        try
        {
            var lodConversion = new LODConversion(LODConstants.DEFAULT_OUTPUT_PATH, paths.ToArray(), BuildContentServerUrl());
            await lodConversion.ConvertLODs();
        }
        catch (Exception e)
        {
            Debug.LogError($"[LOD] BUILD EXCEPTION: {e.Message}\n{e.StackTrace}");
        }
    }

    private string BuildContentServerUrl()
    {
        string tld = networkIndex == 0 ? "org" : "zone";
        return sourceIndex == 0
            ? $"https://peer.decentraland.{tld}/content"
            : $"https://worlds-content-server.decentraland.{tld}";
    }

    private async void DownloadAndAdd(string url)
    {
        isDownloading = true;
        urlStatus = $"Downloading {url}...";
        Repaint();

        try
        {
            string fileName = DeriveFileName(url);
            Directory.CreateDirectory(DOWNLOAD_FOLDER);
            string assetPath = $"{DOWNLOAD_FOLDER}/{fileName}";

            using (var request = UnityWebRequest.Get(url))
            {
                request.downloadHandler = new DownloadHandlerFile(assetPath);
                var op = request.SendWebRequest();
                while (!op.isDone)
                {
                    await System.Threading.Tasks.Task.Yield();
                }

                if (request.result != UnityWebRequest.Result.Success)
                {
                    urlStatus = $"Download failed: {request.error}";
                    File.Delete(assetPath);
                    return;
                }
            }

            AssetDatabase.Refresh();
            var imported = AssetDatabase.LoadAssetAtPath<Object>(assetPath);
            if (imported == null)
            {
                urlStatus = $"Downloaded to {assetPath} but Unity could not import it as an asset.";
                return;
            }

            if (!glbFiles.Contains(imported))
                glbFiles.Add(imported);

            urlStatus = $"Added {fileName}";
            urlInput = "";
        }
        catch (Exception e)
        {
            urlStatus = $"Download error: {e.Message}";
            Debug.LogException(e);
        }
        finally
        {
            isDownloading = false;
            Repaint();
        }
    }

    private static string DeriveFileName(string url)
    {
        string name;
        try
        {
            var uri = new Uri(url);
            name = Path.GetFileName(uri.LocalPath);
        }
        catch
        {
            name = Path.GetFileName(url);
        }

        if (string.IsNullOrEmpty(name))
            name = $"download_{DateTime.UtcNow:yyyyMMdd_HHmmss}.glb";

        if (!name.EndsWith(".glb", StringComparison.OrdinalIgnoreCase) &&
            !name.EndsWith(".gltf", StringComparison.OrdinalIgnoreCase))
            name += ".glb";

        return name;
    }
}
