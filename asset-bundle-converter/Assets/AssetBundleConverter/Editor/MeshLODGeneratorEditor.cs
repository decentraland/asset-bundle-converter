using System.Collections.Generic;
using System.IO;
using UnityEditor;
using UnityEngine;

namespace AssetBundleConverter.Editor
{
    public class MeshLODGeneratorEditor : EditorWindow
    {
        private GameObject sourcePrefab;
        private Vector2 scrollPosition;
        private string lastResult = "";

        // LOD settings
        private int maxLODCount = 3;

        [MenuItem("Decentraland/Mesh LOD Generator")]
        public static void ShowWindow()
        {
            var window = GetWindow<MeshLODGeneratorEditor>("Mesh LOD Generator");
            window.minSize = new Vector2(450, 500);
            window.Show();
        }

        private void OnGUI()
        {
            GUILayout.Label("Mesh LOD Generator", EditorStyles.boldLabel);
            EditorGUILayout.Space();

            EditorGUILayout.HelpBox(
                "This tool generates LOD (Level of Detail) meshes using Unity's MeshLOD system.\n" +
                "Drag a prefab - ALL MeshFilters in the hierarchy will be processed.\n" +
                "Each LOD level will be extracted as a separate .mesh file.\n\n" +
                "Inspired by: https://github.com/staggartcreations/MeshLOD2Fbx",
                MessageType.Info);

            EditorGUILayout.Space();

            // Prefab selection
            EditorGUILayout.LabelField("Source Prefab", EditorStyles.boldLabel);
            sourcePrefab = (GameObject)EditorGUILayout.ObjectField("Prefab", sourcePrefab, typeof(GameObject), false);

            if (sourcePrefab != null)
            {
                MeshFilter[] meshFilters = sourcePrefab.GetComponentsInChildren<MeshFilter>(true);

                if (meshFilters.Length > 0)
                {
                    EditorGUILayout.LabelField($"Found {meshFilters.Length} MeshFilter(s) in hierarchy", EditorStyles.miniLabel);

                    int totalVertices = 0;
                    int totalTriangles = 0;
                    int meshesWithLODs = 0;

                    foreach (var mf in meshFilters)
                    {
                        if (mf.sharedMesh != null)
                        {
                            totalVertices += mf.sharedMesh.vertexCount;
                            totalTriangles += mf.sharedMesh.triangles.Length / 3;
                            if (mf.sharedMesh.lodCount > 0)
                            {
                                meshesWithLODs++;
                            }
                        }
                    }

                    EditorGUILayout.LabelField($"Total Vertices: {totalVertices:N0}", EditorStyles.miniLabel);
                    EditorGUILayout.LabelField($"Total Triangles: {totalTriangles:N0}", EditorStyles.miniLabel);

                    if (meshesWithLODs > 0)
                    {
                        EditorGUILayout.LabelField($"Meshes with existing LODs: {meshesWithLODs}", EditorStyles.miniLabel);
                    }
                }
                else
                {
                    EditorGUILayout.HelpBox("Prefab must have at least one MeshFilter component in its hierarchy.", MessageType.Warning);
                }
            }

            EditorGUILayout.Space();

            // LOD Configuration
            EditorGUILayout.LabelField("LOD Configuration", EditorStyles.boldLabel);

            maxLODCount = EditorGUILayout.IntSlider("Max LOD Levels", maxLODCount, 0, 12);

            EditorGUILayout.HelpBox(
                "This will generate LOD levels using Unity's MeshLodUtility for ALL meshes in the hierarchy.\n" +
                "Each LOD will be progressively more simplified and saved as a separate .mesh file.",
                MessageType.None);

            EditorGUILayout.Space();

            // Generate button
            bool canGenerate = sourcePrefab != null &&
                              sourcePrefab.GetComponentsInChildren<MeshFilter>(true).Length > 0;

            GUI.enabled = canGenerate;
            if (GUILayout.Button("Generate LOD Meshes for All Meshes", GUILayout.Height(35)))
            {
                GenerateLODMeshes();
            }
            GUI.enabled = true;

            EditorGUILayout.Space();

            // Results
            if (!string.IsNullOrEmpty(lastResult))
            {
                EditorGUILayout.LabelField("Last Result:", EditorStyles.boldLabel);
                scrollPosition = EditorGUILayout.BeginScrollView(scrollPosition, GUILayout.Height(150));
                EditorGUILayout.TextArea(lastResult, GUILayout.ExpandHeight(true));
                EditorGUILayout.EndScrollView();
            }
        }

        private void GenerateLODMeshes()
        {
            if (sourcePrefab == null)
            {
                EditorUtility.DisplayDialog("Error", "Please assign a source prefab.", "OK");
                return;
            }

            MeshFilter[] meshFilters = sourcePrefab.GetComponentsInChildren<MeshFilter>(true);
            if (meshFilters.Length == 0)
            {
                EditorUtility.DisplayDialog("Error", "Prefab must have at least one MeshFilter component in its hierarchy.", "OK");
                return;
            }

            string prefabPath = AssetDatabase.GetAssetPath(sourcePrefab);

            if (string.IsNullOrEmpty(prefabPath))
            {
                EditorUtility.DisplayDialog("Error", "Source prefab must be a project asset.", "OK");
                return;
            }

            try
            {
                Debug.Log($"Starting LOD generation for prefab: {sourcePrefab.name}");
                Debug.Log($"Found {meshFilters.Length} MeshFilter(s) in hierarchy");
                Debug.Log($"Prefab path: {prefabPath}");

                string outputFolder = Path.GetDirectoryName(prefabPath);
                List<string> allGeneratedFiles = new List<string>();
                int totalMeshesProcessed = 0;

                // Process each MeshFilter
                for (int mfIndex = 0; mfIndex < meshFilters.Length; mfIndex++)
                {
                    MeshFilter meshFilter = meshFilters[mfIndex];
                    if (meshFilter.sharedMesh == null)
                    {
                        Debug.LogWarning($"Skipping MeshFilter on '{meshFilter.gameObject.name}' - no mesh assigned");
                        continue;
                    }

                    Mesh sourceMesh = meshFilter.sharedMesh;
                    string baseName = sourceMesh.name;

                    float baseProgress = mfIndex / (float)meshFilters.Length;
                    float progressPerMesh = 1.0f / meshFilters.Length;

                    EditorUtility.DisplayProgressBar("Generating LOD Meshes",
                        $"Processing mesh {mfIndex + 1}/{meshFilters.Length}: {baseName}...",
                        baseProgress);

                    Debug.Log($"\n--- Processing Mesh {mfIndex + 1}/{meshFilters.Length}: {baseName} ---");
                    Debug.Log($"  GameObject: {meshFilter.gameObject.name}");
                    Debug.Log($"  Original vertices: {sourceMesh.vertexCount:N0}");
                    Debug.Log($"  Original triangles: {(sourceMesh.triangles.Length / 3):N0}");

                    // Generate LODs using the shared utility
                    EditorUtility.DisplayProgressBar("Generating LOD Meshes",
                        $"Generating LODs for {baseName}...",
                        baseProgress + progressPerMesh * 0.3f);

                    MeshLODGenerator.GenerateLODsForMesh(sourceMesh, maxLODCount);

                    Debug.Log($"  LODs generated. Mesh now has {sourceMesh.lodCount} LOD levels");

                    // Extract each LOD level as a separate mesh file
                    EditorUtility.DisplayProgressBar("Generating LOD Meshes",
                        $"Extracting LOD meshes for {baseName}...",
                        baseProgress + progressPerMesh * 0.5f);

                    List<string> extractedFiles = MeshLODGenerator.ExtractLODMeshesToFiles(sourceMesh, outputFolder);
                    allGeneratedFiles.AddRange(extractedFiles);

                    totalMeshesProcessed++;
                }

                AssetDatabase.SaveAssets();
                AssetDatabase.Refresh();

                EditorUtility.ClearProgressBar();

                string result = $"LOD Generation Complete!\n\n" +
                              $"Source Prefab: {sourcePrefab.name}\n" +
                              $"Meshes Processed: {totalMeshesProcessed}\n" +
                              $"Total LOD Mesh Files Generated: {allGeneratedFiles.Count}\n" +
                              $"Output Folder: {outputFolder}\n\n" +
                              $"Generated Mesh Files:\n";

                foreach (string file in allGeneratedFiles)
                {
                    var mesh = AssetDatabase.LoadAssetAtPath<Mesh>(file);
                    int triCount = 0;
                    for (int i = 0; i < mesh.subMeshCount; i++)
                    {
                        triCount += mesh.GetTriangles(i).Length / 3;
                    }
                    result += $"  - {Path.GetFileName(file)} ({mesh.vertexCount:N0} verts, {triCount:N0} tris)\n";
                }

                Debug.Log(result);
                EditorUtility.DisplayDialog("Success", result, "OK");
                lastResult = result;
                Repaint();

                // Ping the first generated asset in the project browser
                if (allGeneratedFiles.Count > 0)
                {
                    var firstAsset = AssetDatabase.LoadAssetAtPath<Mesh>(allGeneratedFiles[0]);
                    EditorGUIUtility.PingObject(firstAsset);
                }
            }
            catch (System.Exception e)
            {
                EditorUtility.ClearProgressBar();
                string errorMessage = $"Error generating LOD meshes: {e.Message}\n{e.StackTrace}";
                Debug.LogError(errorMessage);
                EditorUtility.DisplayDialog("Error", $"Error generating LOD meshes:\n{e.Message}", "OK");
                lastResult = errorMessage;
                Repaint();
            }
        }
    }
}

