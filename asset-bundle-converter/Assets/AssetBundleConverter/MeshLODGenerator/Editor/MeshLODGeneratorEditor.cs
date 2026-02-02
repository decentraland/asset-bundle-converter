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
                "Drag a prefab - ALL MeshFilters and SkinnedMeshRenderers in the hierarchy will be processed.\n" +
                "Inspired by: https://github.com/staggartcreations/MeshLOD2Fbx",
                MessageType.Info);

            EditorGUILayout.Space();

            // Prefab selection
            EditorGUILayout.LabelField("Source Prefab", EditorStyles.boldLabel);
            sourcePrefab = (GameObject)EditorGUILayout.ObjectField("Prefab", sourcePrefab, typeof(GameObject), false);

            if (sourcePrefab != null)
            {
                var meshSources = MeshLODGenerator.GetAllMeshSources(sourcePrefab);
                MeshFilter[] meshFilters = sourcePrefab.GetComponentsInChildren<MeshFilter>(true);
                SkinnedMeshRenderer[] skinnedMeshRenderers = sourcePrefab.GetComponentsInChildren<SkinnedMeshRenderer>(true);

                if (meshSources.Count > 0)
                {
                    EditorGUILayout.LabelField($"Found {meshFilters.Length} MeshFilter(s) and {skinnedMeshRenderers.Length} SkinnedMeshRenderer(s)", EditorStyles.miniLabel);

                    int totalVertices = 0;
                    int totalTriangles = 0;
                    int meshesWithLODs = 0;

                    foreach (var meshSource in meshSources)
                    {
                        if (meshSource.sharedMesh != null)
                        {
                            totalVertices += meshSource.sharedMesh.vertexCount;
                            totalTriangles += meshSource.sharedMesh.triangles.Length / 3;
                            if (meshSource.sharedMesh.lodCount > 0)
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
                    EditorGUILayout.HelpBox("Prefab must have at least one MeshFilter or SkinnedMeshRenderer component in its hierarchy.", MessageType.Warning);
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
                              MeshLODGenerator.GetAllMeshSources(sourcePrefab).Count > 0;

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

            var meshSources = MeshLODGenerator.GetAllMeshSources(sourcePrefab);
            if (meshSources.Count == 0)
            {
                EditorUtility.DisplayDialog("Error", "Prefab must have at least one MeshFilter or SkinnedMeshRenderer component in its hierarchy.", "OK");
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
                int meshFilterCount = sourcePrefab.GetComponentsInChildren<MeshFilter>(true).Length;
                int skinnedMeshCount = sourcePrefab.GetComponentsInChildren<SkinnedMeshRenderer>(true).Length;

                Debug.Log($"Starting LOD generation for prefab: {sourcePrefab.name}");
                Debug.Log($"Found {meshFilterCount} MeshFilter(s) and {skinnedMeshCount} SkinnedMeshRenderer(s) in hierarchy");
                Debug.Log($"Prefab path: {prefabPath}");

                string outputFolder = Path.GetDirectoryName(prefabPath);
                int totalMeshesProcessed = 0;

                // Process each mesh source (MeshFilter or SkinnedMeshRenderer)
                for (int msIndex = 0; msIndex < meshSources.Count; msIndex++)
                {
                    MeshLODGenerator.MeshSource meshSource = meshSources[msIndex];
                    if (meshSource.sharedMesh == null)
                    {
                        string sourceType = meshSource.isSkinnedMesh ? "SkinnedMeshRenderer" : "MeshFilter";
                        Debug.LogWarning($"Skipping {sourceType} on '{meshSource.gameObject.name}' - no mesh assigned");
                        continue;
                    }

                    Mesh sourceMesh = meshSource.sharedMesh;
                    string baseName = sourceMesh.name;
                    string sourceType2 = meshSource.isSkinnedMesh ? "SkinnedMeshRenderer" : "MeshFilter";

                    float baseProgress = msIndex / (float)meshSources.Count;
                    float progressPerMesh = 1.0f / meshSources.Count;

                    EditorUtility.DisplayProgressBar("Generating LOD Meshes",
                        $"Processing mesh {msIndex + 1}/{meshSources.Count}: {baseName} ({sourceType2})...",
                        baseProgress);

                    Debug.Log($"\n--- Processing Mesh {msIndex + 1}/{meshSources.Count}: {baseName} ({sourceType2}) ---");
                    Debug.Log($"  GameObject: {meshSource.gameObject.name}");
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

                    totalMeshesProcessed++;
                }

                AssetDatabase.SaveAssets();
                AssetDatabase.Refresh();

                EditorUtility.ClearProgressBar();

                string result = $"LOD Generation Complete!\n\n" +
                              $"Source Prefab: {sourcePrefab.name}\n" +
                              $"Meshes Processed: {totalMeshesProcessed}\n" +
                              $"Output Folder: {outputFolder}\n\n" +
                              $"Generated Mesh Files:\n";

                Debug.Log(result);
                EditorUtility.DisplayDialog("Success", result, "OK");
                lastResult = result;
                Repaint();
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

