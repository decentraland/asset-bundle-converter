using System;
using System.Collections.Generic;
using UnityEditor;
using UnityEngine;
using Object = UnityEngine.Object;

public class URLLODWindow : EditorWindow
{
    private readonly List<string> urlList = new();
    private string currentURL = "";
    public static Action<List<string>> OnConvertButtonClicked;

    private void OnGUI()
    {
        GUILayout.Label("Add URLs to process", EditorStyles.boldLabel);

        // Input field for URL
        GUILayout.BeginHorizontal();
        currentURL = EditorGUILayout.TextField("URL:", currentURL);

        // Button to add URL
        if (GUILayout.Button("Add", GUILayout.Width(50)))
        {
            AddURL(currentURL);
        }

        GUILayout.EndHorizontal();

        // Display the list of URLs
        GUILayout.Space(10);
        GUILayout.Label("URLs:");
        for (int i = 0; i < urlList.Count; i++)
        {
            EditorGUILayout.BeginHorizontal();
            urlList[i] = EditorGUILayout.TextField(urlList[i]);

            // Remove button for each URL
            if (GUILayout.Button("Remove", GUILayout.Width(60)))
            {
                urlList.RemoveAt(i);
            }

            EditorGUILayout.EndHorizontal();
        }

        GUILayout.Space(10);

        // Clear All button
        if (urlList.Count > 0 && GUILayout.Button("Clear All"))
        {
            urlList.Clear();
            Debug.Log("Cleared all URLs.");
        }

        // Action button
        if (GUILayout.Button("Process URLs"))
        {
            OnConvertButtonClicked?.Invoke(urlList);
        }
    }

    private void AddURL(string url)
    {
        if (string.IsNullOrEmpty(url))
        {
            Debug.LogWarning("URL cannot be empty.");
            return;
        }

        if (urlList.Contains(url))
        {
            Debug.LogWarning("URL already exists in the list.");
            return;
        }

        urlList.Add(url);
        currentURL = "";
    }

    public static void Open(Action<List<string>> onConvertCallback = null)
    {
        var window = GetWindow<URLLODWindow>("LOD to AssetBundle Converter");
        OnConvertButtonClicked = onConvertCallback;
        window.Show();
    }
}