using System.Collections.Generic;
using System.IO;
using System.Linq;
using AssetBundleConverter;
using AssetBundleConverter.InitialSceneStateGenerator;
using AssetBundleConverter.Wrappers.Implementations;
using Cysharp.Threading.Tasks;
using DCL.ABConverter;
using DCL;
using Newtonsoft.Json;
using UnityEditor;
using UnityEngine;
using UnityEngine.Networking;

namespace DCL.ABConverter.Editor
{
    public class ScenePlacementEditor : EditorWindow
    {
        private string sceneId = "";
        private string downloadedFolder = "Assets/_Downloaded/";
        private bool clearSceneFirst = true;
        private Vector2 scrollPosition;
        private string lastResult = "";
        private List<string> availableManifests = new List<string>();
        private int selectedManifestIndex = 0;

        [MenuItem("Decentraland/Instantiate Initial Scene State")]
        public static void ShowWindow()
        {
            var window = GetWindow<ScenePlacementEditor>("Initial Scene State Instantiator");
            window.minSize = new Vector2(450, 400);
            window.Show();
            window.RefreshAvailableManifests();
        }

        private void OnEnable()
        {
            RefreshAvailableManifests();
        }

        private void RefreshAvailableManifests()
        {
            availableManifests.Clear();

            string manifestFolder = "Assets/_SceneManifest/";
            if (Directory.Exists(manifestFolder))
            {
                string[] manifestFiles = Directory.GetFiles(manifestFolder, "*-lod-manifest.json");
                foreach (string file in manifestFiles)
                {
                    string fileName = Path.GetFileName(file);
                    string id = fileName.Replace("-lod-manifest.json", "");
                    availableManifests.Add(id);
                }
            }

            if (availableManifests.Count > 0 && string.IsNullOrEmpty(sceneId))
            {
                sceneId = availableManifests[0];
            }
        }

        private void OnGUI()
        {
            GUILayout.Label("Scene Asset Placement", EditorStyles.boldLabel);
            EditorGUILayout.Space();

            EditorGUILayout.HelpBox(
                "This tool loads a scene manifest and places all assets from the _Downloaded folder into the scene " +
                "according to their positions and transforms defined in the manifest.\n\n" +
                "Consolidated prefabs (_Consolidated.prefab) will be used when available, falling back to original GLTF assets.",
                MessageType.Info);

            EditorGUILayout.Space();

            // Manifest selection
            EditorGUILayout.LabelField("Scene Manifest", EditorStyles.boldLabel);

            EditorGUILayout.BeginHorizontal();
            if (GUILayout.Button("Refresh Manifests", GUILayout.Width(120)))
            {
                RefreshAvailableManifests();
            }
            GUILayout.Label($"Found {availableManifests.Count} manifest(s)", EditorStyles.miniLabel);
            EditorGUILayout.EndHorizontal();

            if (availableManifests.Count > 0)
            {
                string[] manifestOptions = availableManifests.ToArray();
                int newIndex = EditorGUILayout.Popup("Select Manifest:", selectedManifestIndex, manifestOptions);
                if (newIndex != selectedManifestIndex || string.IsNullOrEmpty(sceneId))
                {
                    selectedManifestIndex = newIndex;
                    sceneId = availableManifests[selectedManifestIndex];
                }
            }
            else
            {
                EditorGUILayout.HelpBox("No manifests found in Assets/_SceneManifest/", MessageType.Warning);
            }

            EditorGUILayout.BeginHorizontal();
            EditorGUILayout.LabelField("Scene ID:", GUILayout.Width(100));
            sceneId = EditorGUILayout.TextField(sceneId);
            EditorGUILayout.EndHorizontal();

            EditorGUILayout.Space();

            // Settings
            EditorGUILayout.LabelField("Settings", EditorStyles.boldLabel);

            EditorGUILayout.BeginHorizontal();
            EditorGUILayout.LabelField("Downloaded Folder:", GUILayout.Width(130));
            downloadedFolder = EditorGUILayout.TextField(downloadedFolder);
            if (GUILayout.Button("Browse", GUILayout.Width(60)))
            {
                string path = EditorUtility.OpenFolderPanel("Select Downloaded Folder", "Assets", "");
                if (!string.IsNullOrEmpty(path))
                {
                    if (path.StartsWith(Application.dataPath))
                    {
                        downloadedFolder = "Assets" + path.Substring(Application.dataPath.Length);
                    }
                }
            }
            EditorGUILayout.EndHorizontal();

            clearSceneFirst = EditorGUILayout.Toggle("Clear Scene First", clearSceneFirst);

            EditorGUILayout.Space();

            // Placement button
            GUI.enabled = !string.IsNullOrEmpty(sceneId);
            if (GUILayout.Button("Generate Scene State & Place Assets", GUILayout.Height(35)))
            {
                PlaceSceneAssets();
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

        private async void PlaceSceneAssets()
        {
            if (string.IsNullOrEmpty(sceneId))
            {
                EditorUtility.DisplayDialog("Error", "Please enter a Scene ID", "OK");
                return;
            }

            string manifestPath = $"Assets/_SceneManifest/{sceneId}-lod-manifest.json";

            if (!File.Exists(manifestPath))
            {
                string message = $"Manifest file not found at: {manifestPath}";
                EditorUtility.DisplayDialog("Error", message, "OK");
                lastResult = message;
                return;
            }

            // Download entity mapping from content server
            string entityMappingJson;
            try
            {
                entityMappingJson = await DownloadEntityMapping(sceneId);
            }
            catch (System.Exception e)
            {
                string message = $"Failed to download entity mapping: {e.Message}";
                EditorUtility.DisplayDialog("Error", message, "OK");
                lastResult = message;
                Debug.LogError(message);
                return;
            }

            try
            {
                // Clear scene if requested
                if (clearSceneFirst)
                    ClearScene();

                // Create environment wrapper
                var env = Environment.CreateWithDefaultImplementations(BuildPipelineType.Scriptable);

                // Parse the EntityMappingsDTO from downloaded JSON
                var entityDTOArray = JsonConvert.DeserializeObject<ContentServerUtils.EntityMappingsDTO[]>(entityMappingJson);

                if (entityDTOArray == null || entityDTOArray.Length == 0)
                {
                    string message = "Failed to parse entity mapping JSON";
                    EditorUtility.DisplayDialog("Error", message, "OK");
                    lastResult = message;
                    return;
                }

                var entityDTO = entityDTOArray[0];

                Debug.Log($"Loading manifest for scene: {sceneId}");
                Debug.Log($"Entity has {entityDTO.content?.Length ?? 0} content mappings");

                // Build hash -> file mapping from content
                var hashToFileMap = new Dictionary<string, string>();
                if (entityDTO.content != null)
                {
                    foreach (var mapping in entityDTO.content)
                    {
                        if (!string.IsNullOrEmpty(mapping.hash) && !string.IsNullOrEmpty(mapping.file))
                        {
                            hashToFileMap[mapping.hash] = mapping.file;
                            Debug.Log($"Mapping: {mapping.hash} -> {mapping.file}");
                        }
                    }
                }

                // Generate initial scene state
                InitialSceneStateGenerator.GenerateInitialSceneState(env, entityDTO);

                Debug.Log("Scene state generated. Finding GLB assets...");

                // Find all GLB/GLTF files in the downloaded folder and map them by hash
                // Prefer _Consolidated prefabs if they exist
                var gltfAssetsByHash = new Dictionary<string, GameObject>(); // hash -> GameObject
                var gltfAssetPathsByHash = new Dictionary<string, string>(); // hash -> file path from manifest
                var consolidatedAssetCount = 0;
                var originalAssetCount = 0;

                // Search for all files in the directory
                if (Directory.Exists(downloadedFolder))
                {
                    string[] allFiles = Directory.GetFiles(downloadedFolder, "*.*", SearchOption.AllDirectories);

                    foreach (string filePath in allFiles)
                    {
                        if (filePath.EndsWith(".glb", System.StringComparison.OrdinalIgnoreCase) ||
                            filePath.EndsWith(".gltf", System.StringComparison.OrdinalIgnoreCase))
                        {
                            string assetPath = filePath.Replace("\\", "/");

                            // Check if a consolidated prefab exists
                            string consolidatedPath = Path.ChangeExtension(assetPath, null) + "_Consolidated.prefab";
                            GameObject asset = null;
                            bool isConsolidated = false;

                            if (File.Exists(consolidatedPath))
                            {
                                // Prefer the consolidated prefab
                                asset = AssetDatabase.LoadAssetAtPath<GameObject>(consolidatedPath);
                                if (asset != null)
                                {
                                    isConsolidated = true;
                                    consolidatedAssetCount++;
                                    Debug.Log($"Using consolidated prefab: {consolidatedPath}");
                                }
                            }

                            // Fallback to original GLTF if no consolidated prefab exists
                            if (asset == null)
                            {
                                asset = AssetDatabase.LoadAssetAtPath<GameObject>(assetPath);
                                if (asset != null)
                                {
                                    originalAssetCount++;
                                    Debug.Log($"Using original GLTF: {assetPath}");
                                }
                            }

                            if (asset != null)
                            {
                                // Extract the hash from the path (typically Assets/_Downloaded/hash/hash.glb)
                                string hash = ExtractHashFromPath(assetPath);

                                if (!string.IsNullOrEmpty(hash))
                                {
                                    gltfAssetsByHash[hash] = asset;

                                    // Look up the file path from the content mapping
                                    if (hashToFileMap.TryGetValue(hash, out string manifestFilePath))
                                    {
                                        gltfAssetPathsByHash[hash] = manifestFilePath;
                                        Debug.Log($"Found asset: hash={hash}, manifest path={manifestFilePath}, type={( isConsolidated ? "Consolidated" : "Original")}");
                                    }
                                    else
                                    {
                                        Debug.LogWarning($"Asset hash {hash} not found in manifest content mapping");
                                    }
                                }
                            }
                        }
                    }
                }
                else
                {
                    Debug.LogError($"Downloaded folder does not exist: {downloadedFolder}");
                }

                Debug.Log($"Asset types - Consolidated: {consolidatedAssetCount}, Original: {originalAssetCount}");

                Debug.Log($"Found {gltfAssetsByHash.Count} GLB/GLTF assets. Placing in scene...");

                // Place assets using the manifest file paths
                int placedCount = 0;
                int totalProgress = gltfAssetsByHash.Count;
                int currentProgress = 0;

                foreach (var kvp in gltfAssetsByHash)
                {
                    currentProgress++;
                    string hash = kvp.Key;
                    GameObject asset = kvp.Value;

                    EditorUtility.DisplayProgressBar("Placing Assets",
                        $"Placing {asset.name}...",
                        currentProgress / (float)totalProgress);

                    try
                    {
                        // Get the manifest file path for this hash
                        if (!gltfAssetPathsByHash.TryGetValue(hash, out string manifestFilePath))
                        {
                            Debug.LogWarning($"Asset with hash {hash} ({asset.name}) not found in manifest content mapping");
                            continue;
                        }

                        int beforeCount = GameObject.FindObjectsOfType<GameObject>().Length;

                        // Use the manifest file path to place the asset
                        InitialSceneStateGenerator.PlaceAsset(manifestFilePath, asset);

                        int afterCount = GameObject.FindObjectsOfType<GameObject>().Length;
                        int instancesCreated = afterCount - beforeCount;

                        if (instancesCreated > 0)
                        {
                            placedCount += instancesCreated;
                            Debug.Log($"Placed {instancesCreated} instance(s) of {asset.name} (hash: {hash}, path: {manifestFilePath})");
                        }
                        else
                        {
                            Debug.LogWarning($"Asset {asset.name} ({manifestFilePath}) found but not placed (might not be used in scene)");
                        }
                    }
                    catch (System.Exception e)
                    {
                        Debug.LogError($"Error placing asset {hash}: {e.Message}");
                    }
                }

                EditorUtility.ClearProgressBar();

                string result = $"Scene Placement Complete!\n\n" +
                              $"Scene ID: {sceneId}\n" +
                              $"Assets Found: {gltfAssetsByHash.Count}\n" +
                              $"  - Consolidated Prefabs: {consolidatedAssetCount}\n" +
                              $"  - Original GLTF: {originalAssetCount}\n" +
                              $"Assets Mapped: {gltfAssetPathsByHash.Count}\n" +
                              $"Instances Placed: {placedCount}";

                Debug.Log(result);
                EditorUtility.DisplayDialog("Success", result, "OK");
                lastResult = result;
                Repaint();

                // Mark scene as dirty
                UnityEngine.SceneManagement.Scene activeScene = UnityEngine.SceneManagement.SceneManager.GetActiveScene();
                UnityEditor.SceneManagement.EditorSceneManager.MarkSceneDirty(activeScene);
            }
            catch (System.Exception e)
            {
                EditorUtility.ClearProgressBar();
                string errorMessage = $"Error placing assets: {e.Message}\n{e.StackTrace}";
                Debug.LogError(errorMessage);
                EditorUtility.DisplayDialog("Error", $"Error placing assets:\n{e.Message}", "OK");
                lastResult = errorMessage;
                Repaint();
            }
        }

        private string ExtractHashFromPath(string fullAssetPath)
        {
            // The typical path structure is: Assets/_Downloaded/hash/hash.glb
            // We need to extract the hash

            // Normalize the path
            fullAssetPath = fullAssetPath.Replace("\\", "/");

            // Try to extract from the directory name first (most reliable)
            // Path format: Assets/_Downloaded/hash/hash.glb
            string[] pathParts = fullAssetPath.Split('/');

            // Look for _Downloaded in the path
            for (int i = 0; i < pathParts.Length - 1; i++)
            {
                if (pathParts[i] == "_Downloaded" && i + 1 < pathParts.Length)
                {
                    // The next part should be the hash
                    return pathParts[i + 1];
                }
            }

            // Fallback: use filename without extension
            return Path.GetFileNameWithoutExtension(fullAssetPath);
        }

        private async UniTask<string> DownloadEntityMapping(string sceneId)
        {
            const string url = "https://peer.decentraland.org/content/entities/active";
            string jsonBody = "{\"ids\":[\"" + sceneId + "\"]}";

            Debug.Log($"Downloading entity mapping for scene: {sceneId}");

            using (var request = UnityWebRequest.Post(url, jsonBody, "application/json"))
            {
                await request.SendWebRequest();

                if (request.result != UnityWebRequest.Result.Success)
                    throw new System.Exception($"Request failed: {request.error}");

                string responseJson = request.downloadHandler.text;
                Debug.Log($"Entity mapping downloaded successfully ({responseJson.Length} bytes)");
                return responseJson;
            }
        }

        private void ClearScene()
        {
            if (!EditorUtility.DisplayDialog("Clear Scene",
                "Are you sure you want to delete all GameObjects in the scene?",
                "Yes", "Cancel"))
            {
                return;
            }

            Debug.Log("Clearing scene...");

            var allObjects = GameObject.FindObjectsOfType<GameObject>();
            int deletedCount = 0;

            foreach (var obj in allObjects)
            {
                // Skip camera and lights
                if (obj.GetComponent<Camera>() != null || obj.GetComponent<Light>() != null)
                    continue;

                // Only delete root objects (children will be deleted automatically)
                if (obj.transform.parent == null)
                {
                    DestroyImmediate(obj);
                    deletedCount++;
                }
            }

            Debug.Log($"Cleared {deletedCount} objects from scene");
        }
    }
}

