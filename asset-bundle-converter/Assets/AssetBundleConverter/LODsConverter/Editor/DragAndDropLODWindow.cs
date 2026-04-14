using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using AssetBundleConverter.LODsConverter.Utils;
using UnityEditor;
using UnityEngine;
using Object = UnityEngine.Object;

public class DragAndDropLODWindow : EditorWindow
{
    private readonly List<Object> glbFiles = new ();

    [MenuItem("Decentraland/LOD/Build GLB Asset Bundles")]
    public static void Open()
    {
        var window = GetWindow<DragAndDropLODWindow>("GLB → Asset Bundle");
        window.Show();
    }

    private void OnGUI()
    {
        GUILayout.Label("Drop GLB files to build as Asset Bundles", EditorStyles.boldLabel);

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

    private static async void RunConversion(List<string> paths)
    {
        try
        {
            var lodConversion = new LODConversion(LODConstants.DEFAULT_OUTPUT_PATH, paths.ToArray());
            await lodConversion.ConvertLODs();
        }
        catch (Exception e)
        {
            Debug.LogError($"[LOD] BUILD EXCEPTION: {e.Message}\n{e.StackTrace}");
        }
    }
}
