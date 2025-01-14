using System;
using System.Collections.Generic;
using UnityEditor;
using UnityEngine;
using Object = UnityEngine.Object;

public class DragAndDropLOD : EditorWindow
{
    private readonly List<Object> fbxFiles = new ();
    public static Action<List<Object>> OnConvertButtonClicked;

    private void OnGUI()
    {
        GUILayout.Label("Drop your LODs to convert here", EditorStyles.boldLabel);

        // Define a drop area
        var dropArea = GUILayoutUtility.GetRect(0, 100, GUILayout.ExpandWidth(true));
        GUI.Box(dropArea, "Only FBXs allowed", EditorStyles.helpBox);

        // Check events
        var evt = Event.current;

        if (evt.type == EventType.DragUpdated || evt.type == EventType.DragPerform)
        {
            if (dropArea.Contains(evt.mousePosition))
            {
                // Show a copy cursor when dragging over the drop area
                DragAndDrop.visualMode = DragAndDropVisualMode.Copy;

                if (evt.type == EventType.DragPerform)
                {
                    DragAndDrop.AcceptDrag();

                    // Handle all dragged objects
                    foreach (var obj in DragAndDrop.objectReferences)
                    {
                        string path = AssetDatabase.GetAssetPath(obj);

                        // Check if the file is an FBX
                        if (!path.EndsWith(".fbx", StringComparison.OrdinalIgnoreCase)) continue;
                        if (!fbxFiles.Contains(obj))
                            fbxFiles.Add(obj);
                    }

                    evt.Use();
                }
            }
        }

        // Display the list of FBX files
        GUILayout.Space(10);
        GUILayout.Label("FBX Files:");
        for (int i = 0; i < fbxFiles.Count; i++)
        {
            EditorGUILayout.BeginHorizontal();
            fbxFiles[i] = EditorGUILayout.ObjectField(fbxFiles[i], typeof(Object), false);

            // Add a remove button for each file
            if (GUILayout.Button("Remove", GUILayout.Width(60)))
            {
                fbxFiles.RemoveAt(i);
            }

            EditorGUILayout.EndHorizontal();
        }

        GUILayout.Space(10);

        // Action button
        if (GUILayout.Button("Convert LODs to ABs"))
        {
            OnConvertButtonClicked?.Invoke(fbxFiles);
        }
    }

    // Static method to open the window
    public static void Open(Action<List<Object>> onConvertCallback = null)
    {
        var window = GetWindow<DragAndDropLOD>("LOD to AssetBundle Converter");
        OnConvertButtonClicked = onConvertCallback;
        window.Show();
    }
}