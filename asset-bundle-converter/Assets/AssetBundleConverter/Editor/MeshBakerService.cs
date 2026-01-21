using UnityEngine;
using UnityEditor;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using DigitalOpus.MB.Core;
using DigitalOpus.MB.MBEditor;
using AssetBundleConverter;

namespace DCL.ABConverter
{
    /// <summary>
    /// Service class for integrating MeshBaker into the AssetBundleConverter pipeline.
    /// Provides programmatic access to texture atlasing and prefab baking functionality.
    /// </summary>
    public static class MeshBakerService
    {
        /// <summary>
        /// Settings for MeshBaker processing
        /// </summary>
        public class MeshBakerSettings
        {
            public int MaxAtlasSize = 2048;
            public int MaxTilingBakeSize = 512;
            public bool ConsiderMeshUVs = true;
            public MB2_LightmapOptions LightmapOption = MB2_LightmapOptions.copy_UV2_unchanged;
            public List<string> TexturesToIgnore = new List<string>
            {
                "_EmissionMap",
                "_BumpMap",
                "_MetallicGlossMap",
                "_OcclusionMap"
            };
            public bool RenameOriginalPrefab = false;

            /// <summary>
            /// Number of assets per shared atlas. 0 or negative = all assets in one atlas.
            /// </summary>
            public int AssetsPerAtlas = 1;

            /// <summary>
            /// Output folder for shared atlases and baked prefabs.
            /// </summary>
            public string OutputFolder = null;
        }

        /// <summary>
        /// Result of MeshBaker processing
        /// </summary>
        public class ProcessingResult
        {
            public bool Success;
            public string OriginalPrefabPath;
            public string BakedPrefabPath;
            public string AtlasAssetPath;
            public string ErrorMessage;
        }

        /// <summary>
        /// Result of batched MeshBaker processing (multiple assets sharing one atlas)
        /// </summary>
        public class BatchedProcessingResult
        {
            public bool Success;
            public string AtlasAssetPath;
            public string SharedMaterialPath;
            public List<ProcessingResult> PrefabResults = new List<ProcessingResult>();
            public string ErrorMessage;
        }

        private static readonly MeshBakerSettings DefaultSettings = new MeshBakerSettings();

        /// <summary>
        /// Creates MeshBakerSettings from ClientSettings
        /// </summary>
        public static MeshBakerSettings CreateSettingsFromClientSettings(ClientSettings clientSettings)
        {
            return new MeshBakerSettings
            {
                MaxAtlasSize = clientSettings.meshBakerMaxAtlasSize,
                MaxTilingBakeSize = clientSettings.meshBakerMaxTilingBakeSize,
                ConsiderMeshUVs = true,
                LightmapOption = MB2_LightmapOptions.copy_UV2_unchanged,
                RenameOriginalPrefab = false,
                AssetsPerAtlas = clientSettings.meshBakerAssetsPerAtlas
            };
        }

        /// <summary>
        /// Process a prefab or model asset with MeshBaker to create texture atlas and optimized prefab.
        /// Supports both regular prefabs (.prefab) and model assets (.gltf, .glb, .fbx, etc.)
        /// </summary>
        /// <param name="assetPath">Path to the prefab or model asset</param>
        /// <param name="settings">Optional MeshBaker settings. Uses defaults if null.</param>
        /// <returns>Processing result with paths to created assets</returns>
        public static ProcessingResult ProcessPrefab(string assetPath, MeshBakerSettings settings = null)
        {
            settings ??= DefaultSettings;
            var result = new ProcessingResult { OriginalPrefabPath = assetPath };

            try
            {
                // Load the asset (works for both prefabs and model assets like GLTF/GLB)
                GameObject prefabAsset = AssetDatabase.LoadAssetAtPath<GameObject>(assetPath);
                if (prefabAsset == null)
                {
                    result.ErrorMessage = $"Could not load asset at path: {assetPath}";
                    return result;
                }

                // Check if asset has any renderers
                Renderer[] renderers = prefabAsset.GetComponentsInChildren<Renderer>(true);
                if (renderers.Length == 0)
                {
                    Debug.Log($"[MeshBakerService] Skipping {assetPath} - no renderers found");
                    result.Success = true; // Not an error, just nothing to process
                    result.BakedPrefabPath = assetPath;
                    return result;
                }

                // Determine if this is a model asset (GLTF, GLB, FBX, etc.) or a regular prefab
                bool isModelAsset = IsModelAsset(assetPath);

                // Create a temporary instance in the scene
                GameObject prefabInstance;
                if (isModelAsset)
                {
                    // For model assets (GLTF, GLB, etc.), use Object.Instantiate
                    prefabInstance = Object.Instantiate(prefabAsset);
                    prefabInstance.name = prefabAsset.name; // Remove "(Clone)" suffix
                }
                else
                {
                    // For regular prefabs, use PrefabUtility.InstantiatePrefab
                    prefabInstance = (GameObject)PrefabUtility.InstantiatePrefab(prefabAsset);
                }

                if (prefabInstance == null)
                {
                    result.ErrorMessage = $"Could not instantiate asset: {assetPath}";
                    return result;
                }

                try
                {
                    // Process with MeshBaker
                    result = ProcessPrefabInstance(prefabInstance, prefabAsset, assetPath, settings, isModelAsset);
                }
                finally
                {
                    // Clean up the instance
                    Object.DestroyImmediate(prefabInstance);
                }
            }
            catch (System.Exception ex)
            {
                result.ErrorMessage = $"Exception processing asset: {ex.Message}";
                Debug.LogException(ex);
            }

            return result;
        }

        /// <summary>
        /// Check if the asset is a model asset (GLTF, GLB, FBX, etc.) as opposed to a regular prefab.
        /// </summary>
        private static bool IsModelAsset(string assetPath)
        {
            string ext = Path.GetExtension(assetPath).ToLowerInvariant();
            return ext == ".gltf" || ext == ".glb" || ext == ".fbx" || ext == ".obj" || ext == ".dae";
        }

        /// <summary>
        /// Process a prefab instance that's already in the scene.
        /// </summary>
        private static ProcessingResult ProcessPrefabInstance(GameObject prefabInstance, GameObject prefabAsset, string originalAssetPath, MeshBakerSettings settings, bool isModelAsset = false)
        {
            var result = new ProcessingResult { OriginalPrefabPath = originalAssetPath };

            string assetFolder = Path.GetDirectoryName(originalAssetPath);
            string assetName = Path.GetFileNameWithoutExtension(originalAssetPath);

            // For model assets, we'll create a separate prefab
            string prefabFolder = assetFolder;
            string prefabName = assetName;

            GameObject bakerGO = null;

            try
            {
                // Create Baker GameObject
                bakerGO = new GameObject($"MeshBaker_{prefabName}");

                // Add components
                MB3_BatchPrefabBaker batchPrefabBaker = bakerGO.AddComponent<MB3_BatchPrefabBaker>();
                MB3_TextureBaker textureBaker = bakerGO.AddComponent<MB3_TextureBaker>();
                MB3_MeshBaker meshBaker = bakerGO.AddComponent<MB3_MeshBaker>();

                // Configure Texture Baker
                textureBaker.maxAtlasSize = settings.MaxAtlasSize;
                textureBaker.maxTilingBakeSize = settings.MaxTilingBakeSize;
                textureBaker.fixOutOfBoundsUVs = settings.ConsiderMeshUVs;
                textureBaker.packingAlgorithm = MB2_PackingAlgorithmEnum.MeshBakerTexturePacker;

                // Set textures to ignore
                textureBaker.texturePropNamesToIgnore.Clear();
                textureBaker.texturePropNamesToIgnore.AddRange(settings.TexturesToIgnore);

                // Configure Mesh Baker
                meshBaker.meshCombiner.settings.lightmapOption = settings.LightmapOption;
                meshBaker.meshCombiner.outputOption = MB2_OutputOptions.bakeMeshAssetsInPlace;

                // Collect renderers
                Renderer[] renderers = prefabInstance.GetComponentsInChildren<Renderer>(true);
                List<GameObject> objectsToCombine = new List<GameObject>();

                foreach (Renderer r in renderers)
                {
                    if (r is MeshRenderer || r is SkinnedMeshRenderer)
                    {
                        objectsToCombine.Add(r.gameObject);
                    }
                }

                if (objectsToCombine.Count == 0)
                {
                    result.Success = true;
                    result.BakedPrefabPath = originalAssetPath;
                    return result;
                }

                // Add objects to texture baker
                textureBaker.GetObjectsToCombine().Clear();
                textureBaker.GetObjectsToCombine().AddRange(objectsToCombine);

                // Create assets
                string assetBasePath = $"{prefabFolder}/{prefabName}_Atlas";
                string assetPath = AssetDatabase.GenerateUniqueAssetPath($"{assetBasePath}.asset");
                string matPath = AssetDatabase.GenerateUniqueAssetPath($"{assetBasePath}_mat.mat");

                // Create material
                Material newMat = CreateMaterialFromRenderers(objectsToCombine);
                AssetDatabase.CreateAsset(newMat, matPath);
                textureBaker.resultMaterial = (Material)AssetDatabase.LoadAssetAtPath(matPath, typeof(Material));

                // Create TextureBakeResults
                AssetDatabase.CreateAsset(ScriptableObject.CreateInstance<MB2_TextureBakeResults>(), assetPath);
                MB2_TextureBakeResults textureBakeResults = (MB2_TextureBakeResults)AssetDatabase.LoadAssetAtPath(assetPath, typeof(MB2_TextureBakeResults));
                textureBaker.textureBakeResults = textureBakeResults;
                // Also set on mesh baker - required for BakePrefabs to work
                meshBaker.textureBakeResults = textureBakeResults;
                result.AtlasAssetPath = assetPath;

                AssetDatabase.Refresh();

                // Bake textures
                Debug.Log($"[MeshBakerService] Baking textures for {prefabName}...");
                textureBaker.CreateAtlases(null, true, new MB3_EditorMethods());

                if (textureBaker.textureBakeResults != null)
                {
                    EditorUtility.SetDirty(textureBaker.textureBakeResults);
                }

                // Cleanup result material
                CleanupResultMaterial(textureBaker.resultMaterial, settings.TexturesToIgnore);

                // Configure BatchPrefabBaker
                batchPrefabBaker.outputPrefabFolder = prefabFolder;

                if (isModelAsset)
                {
                    // For model assets (GLTF, GLB, etc.), manually create the prefab row
                    // since PrefabUtility_GetCorrespondingObjectFromSource doesn't work for them
                    var row = new MB3_BatchPrefabBaker.MB3_PrefabBakerRow { sourcePrefab = prefabAsset };
                    batchPrefabBaker.prefabRows = new MB3_BatchPrefabBaker.MB3_PrefabBakerRow[] { row };
                }
                else
                {
                    // For regular prefabs, use the standard populate method
                    PopulatePrefabRows(batchPrefabBaker, textureBaker);
                }

                // Remove empty rows
                RemoveEmptyPrefabRows(batchPrefabBaker);

                if (batchPrefabBaker.prefabRows.Length == 0)
                {
                    result.Success = true;
                    result.BakedPrefabPath = originalAssetPath;
                    Debug.Log($"[MeshBakerService] No valid prefab rows for {prefabName}, skipping batch bake");
                    return result;
                }

                // Create empty result prefabs
                Debug.Log($"[MeshBakerService] Creating empty output prefabs for {prefabName}...");
                try
                {
                    MB_BatchPrefabBakerEditorFunctions.CreateEmptyOutputPrefabs(batchPrefabBaker.outputPrefabFolder, batchPrefabBaker);
                }
                catch (System.Exception createEx)
                {
                    Debug.LogError($"[MeshBakerService] Exception during CreateEmptyOutputPrefabs for {prefabName}: {createEx.Message}");
                    Debug.LogException(createEx);
                    throw;
                }

                // Bake prefabs
                Debug.Log($"[MeshBakerService] Baking prefabs for {prefabName}...");
                try
                {
                    MB_BatchPrefabBakerEditorFunctions.BakePrefabs(batchPrefabBaker, true);
                }
                catch (System.Exception bakeEx)
                {
                    Debug.LogError($"[MeshBakerService] Exception during BakePrefabs for {prefabName}: {bakeEx.Message}");
                    Debug.LogException(bakeEx);
                    throw; // Re-throw to be caught by outer handler
                }

                // Get result prefab path
                if (batchPrefabBaker.prefabRows.Length > 0 && batchPrefabBaker.prefabRows[0].resultPrefab != null)
                {
                    result.BakedPrefabPath = AssetDatabase.GetAssetPath(batchPrefabBaker.prefabRows[0].resultPrefab);
                }
                else
                {
                    result.BakedPrefabPath = originalAssetPath;
                }

                // Rename original prefab
                if (settings.RenameOriginalPrefab)
                {
                    RenameOriginalPrefab(originalAssetPath);
                }

                result.Success = true;

                Debug.Log($"[MeshBakerService] Successfully processed {prefabName}");
            }
            catch (System.Exception ex)
            {
                result.ErrorMessage = ex.Message;
                Debug.LogError($"[MeshBakerService] Error processing {prefabName}: {ex.Message}");
                Debug.LogException(ex);
            }
            finally
            {
                // Cleanup baker
                if (bakerGO != null)
                {
                    Object.DestroyImmediate(bakerGO);
                }

                EditorUtility.ClearProgressBar();
            }

            return result;
        }

        private static Material CreateMaterialFromRenderers(List<GameObject> objectsToCombine)
        {
            Material newMat = null;

            if (objectsToCombine.Count > 0)
            {
                Renderer firstRenderer = objectsToCombine[0].GetComponent<Renderer>();
                if (firstRenderer != null && firstRenderer.sharedMaterial != null)
                {
                    newMat = new Material(firstRenderer.sharedMaterial);
                    MB3_TextureBaker.ConfigureNewMaterialToMatchOld(newMat, firstRenderer.sharedMaterial);
                }
            }

            return newMat ?? new Material(Shader.Find("Standard"));
        }

        private static void CleanupResultMaterial(Material mat, List<string> ignoredProps)
        {
            if (mat == null || ignoredProps == null) return;

            foreach (string prop in ignoredProps)
            {
                switch (prop)
                {
                    case "_EmissionMap":
                        if (mat.HasProperty("_EmissionColor"))
                            mat.SetColor("_EmissionColor", Color.black);
                        if (mat.HasProperty("_EmissionMap"))
                            mat.SetTexture("_EmissionMap", null);
                        mat.DisableKeyword("_EMISSION");
                        mat.globalIlluminationFlags = MaterialGlobalIlluminationFlags.EmissiveIsBlack;
                        break;

                    case "_BumpMap":
                    case "_NormalMap":
                        if (mat.HasProperty("_BumpMap"))
                            mat.SetTexture("_BumpMap", null);
                        if (mat.HasProperty("_NormalMap"))
                            mat.SetTexture("_NormalMap", null);
                        mat.DisableKeyword("_NORMALMAP");
                        break;

                    case "_MetallicGlossMap":
                        if (mat.HasProperty("_MetallicGlossMap"))
                            mat.SetTexture("_MetallicGlossMap", null);
                        if (mat.HasProperty("_Metallic"))
                            mat.SetFloat("_Metallic", 0f);
                        if (mat.HasProperty("_Glossiness"))
                            mat.SetFloat("_Glossiness", 0.5f);
                        mat.DisableKeyword("_METALLICGLOSSMAP");
                        break;

                    case "_OcclusionMap":
                        if (mat.HasProperty("_OcclusionMap"))
                            mat.SetTexture("_OcclusionMap", null);
                        break;
                }
            }

            EditorUtility.SetDirty(mat);
        }

        private static void PopulatePrefabRows(MB3_BatchPrefabBaker batchPrefabBaker, MB3_TextureBaker textureBaker)
        {
            List<GameObject> newPrefabs = new List<GameObject>();
            List<GameObject> gos = textureBaker.GetObjectsToCombine();

            foreach (var go in gos)
            {
                if (go == null) continue;

                GameObject prefabRoot = MBVersionEditor.PrefabUtility_FindPrefabRoot(go);
                if (prefabRoot == null) continue;

                Object obj = MBVersionEditor.PrefabUtility_GetCorrespondingObjectFromSource(prefabRoot);

                if (obj is GameObject prefab && !newPrefabs.Contains(prefab))
                {
                    newPrefabs.Add(prefab);
                }
            }

            List<MB3_BatchPrefabBaker.MB3_PrefabBakerRow> rows = new List<MB3_BatchPrefabBaker.MB3_PrefabBakerRow>();

            foreach (var prefab in newPrefabs)
            {
                var row = new MB3_BatchPrefabBaker.MB3_PrefabBakerRow { sourcePrefab = prefab };
                rows.Add(row);
            }

            batchPrefabBaker.prefabRows = rows.ToArray();
        }

        private static void RemoveEmptyPrefabRows(MB3_BatchPrefabBaker batchPrefabBaker)
        {
            if (batchPrefabBaker.prefabRows == null) return;

            var validRows = new List<MB3_BatchPrefabBaker.MB3_PrefabBakerRow>();

            foreach (var row in batchPrefabBaker.prefabRows)
            {
                if (row?.sourcePrefab != null)
                {
                    validRows.Add(row);
                }
            }

            batchPrefabBaker.prefabRows = validRows.ToArray();
        }

        private static void RenameOriginalPrefab(string originalPath)
        {
            if (string.IsNullOrEmpty(originalPath)) return;

            string fileName = Path.GetFileNameWithoutExtension(originalPath);

            if (fileName.EndsWith("_original")) return;

            string newFileName = $"{fileName}_original";
            string error = AssetDatabase.RenameAsset(originalPath, newFileName);

            if (string.IsNullOrEmpty(error))
            {
                Debug.Log($"[MeshBakerService] Renamed original prefab to {newFileName}");
                // Note: Don't call AssetDatabase.Refresh() here - it will be called at the end of batch processing
            }
            else
            {
                Debug.LogWarning($"[MeshBakerService] Failed to rename prefab: {error}");
            }
        }

        /// <summary>
        /// Process multiple prefabs in batch.
        /// </summary>
        public static List<ProcessingResult> ProcessPrefabs(IEnumerable<string> prefabPaths, MeshBakerSettings settings = null)
        {
            var results = new List<ProcessingResult>();
            int count = 0;
            var pathList = new List<string>(prefabPaths);
            int total = pathList.Count;

            foreach (string path in pathList)
            {
                count++;
                EditorUtility.DisplayProgressBar("MeshBaker Processing",
                    $"Processing {count}/{total}: {Path.GetFileName(path)}",
                    count / (float)total);

                var result = ProcessPrefab(path, settings);
                results.Add(result);
            }

            EditorUtility.ClearProgressBar();

            int successCount = results.FindAll(r => r.Success).Count;
            Debug.Log($"[MeshBakerService] Batch processing complete: {successCount}/{total} succeeded");

            return results;
        }

        /// <summary>
        /// Process multiple prefabs with a SHARED atlas. All prefabs in the batch will use
        /// the same atlas texture and material, reducing draw calls.
        /// </summary>
        /// <param name="prefabPaths">Paths to the prefabs/models to process together</param>
        /// <param name="outputFolder">Folder where shared atlas and baked prefabs will be saved</param>
        /// <param name="batchName">Name for the shared atlas (e.g., "Batch_0")</param>
        /// <param name="settings">MeshBaker settings</param>
        /// <returns>Result containing shared atlas info and individual prefab results</returns>
        public static BatchedProcessingResult ProcessPrefabsWithSharedAtlas(
            List<string> prefabPaths,
            string outputFolder,
            string batchName,
            MeshBakerSettings settings = null)
        {
            settings ??= DefaultSettings;
            var result = new BatchedProcessingResult();

            if (prefabPaths == null || prefabPaths.Count == 0)
            {
                result.ErrorMessage = "No prefab paths provided";
                return result;
            }

            // Ensure output folder exists
            if (!Directory.Exists(outputFolder))
            {
                Directory.CreateDirectory(outputFolder);
            }

            GameObject bakerGO = null;
            var prefabInstances = new List<(GameObject instance, GameObject prefabAsset, string path)>();

            try
            {
                Debug.Log($"[MeshBakerService] Processing batch '{batchName}' with {prefabPaths.Count} prefabs...");

                // Create Baker GameObject
                bakerGO = new GameObject($"MeshBaker_{batchName}");

                // Add components
                MB3_BatchPrefabBaker batchPrefabBaker = bakerGO.AddComponent<MB3_BatchPrefabBaker>();
                MB3_TextureBaker textureBaker = bakerGO.AddComponent<MB3_TextureBaker>();
                MB3_MeshBaker meshBaker = bakerGO.AddComponent<MB3_MeshBaker>();

                // Configure Texture Baker
                textureBaker.maxAtlasSize = settings.MaxAtlasSize;
                textureBaker.maxTilingBakeSize = settings.MaxTilingBakeSize;
                textureBaker.fixOutOfBoundsUVs = settings.ConsiderMeshUVs;
                textureBaker.packingAlgorithm = MB2_PackingAlgorithmEnum.MeshBakerTexturePacker;

                // Set textures to ignore
                textureBaker.texturePropNamesToIgnore.Clear();
                textureBaker.texturePropNamesToIgnore.AddRange(settings.TexturesToIgnore);

                // Configure Mesh Baker
                meshBaker.meshCombiner.settings.lightmapOption = settings.LightmapOption;
                meshBaker.meshCombiner.outputOption = MB2_OutputOptions.bakeMeshAssetsInPlace;

                // Collect all renderers from ALL prefabs
                List<GameObject> allObjectsToCombine = new List<GameObject>();
                var prefabRows = new List<MB3_BatchPrefabBaker.MB3_PrefabBakerRow>();

                foreach (string prefabPath in prefabPaths)
                {
                    GameObject prefabAsset = AssetDatabase.LoadAssetAtPath<GameObject>(prefabPath);
                    if (prefabAsset == null)
                    {
                        Debug.LogWarning($"[MeshBakerService] Could not load prefab: {prefabPath}");
                        result.PrefabResults.Add(new ProcessingResult
                        {
                            OriginalPrefabPath = prefabPath,
                            Success = false,
                            ErrorMessage = "Could not load prefab"
                        });
                        continue;
                    }

                    // Instantiate the prefab
                    bool isModelAsset = IsModelAsset(prefabPath);
                    GameObject instance;

                    if (isModelAsset)
                    {
                        instance = Object.Instantiate(prefabAsset);
                        instance.name = prefabAsset.name;
                    }
                    else
                    {
                        instance = (GameObject)PrefabUtility.InstantiatePrefab(prefabAsset);
                    }

                    if (instance == null)
                    {
                        Debug.LogWarning($"[MeshBakerService] Could not instantiate: {prefabPath}");
                        result.PrefabResults.Add(new ProcessingResult
                        {
                            OriginalPrefabPath = prefabPath,
                            Success = false,
                            ErrorMessage = "Could not instantiate prefab"
                        });
                        continue;
                    }

                    prefabInstances.Add((instance, prefabAsset, prefabPath));

                    // Collect renderers from this instance
                    Renderer[] renderers = instance.GetComponentsInChildren<Renderer>(true);
                    foreach (Renderer r in renderers)
                    {
                        if (r is MeshRenderer || r is SkinnedMeshRenderer)
                        {
                            allObjectsToCombine.Add(r.gameObject);
                        }
                    }

                    // Add to prefab rows for batch baking
                    var row = new MB3_BatchPrefabBaker.MB3_PrefabBakerRow { sourcePrefab = prefabAsset };
                    prefabRows.Add(row);
                }

                if (allObjectsToCombine.Count == 0)
                {
                    result.Success = true;
                    result.ErrorMessage = "No renderers found in any prefab";
                    Debug.Log($"[MeshBakerService] No renderers found in batch '{batchName}'");
                    return result;
                }

                // Add all objects to texture baker
                textureBaker.GetObjectsToCombine().Clear();
                textureBaker.GetObjectsToCombine().AddRange(allObjectsToCombine);

                // Create shared atlas assets in the output folder
                string atlasBasePath = $"{outputFolder}/{batchName}_Atlas";
                string atlasAssetPath = AssetDatabase.GenerateUniqueAssetPath($"{atlasBasePath}.asset");
                string matPath = AssetDatabase.GenerateUniqueAssetPath($"{atlasBasePath}_mat.mat");

                // Create shared material
                Material sharedMat = CreateMaterialFromRenderers(allObjectsToCombine);
                AssetDatabase.CreateAsset(sharedMat, matPath);
                textureBaker.resultMaterial = (Material)AssetDatabase.LoadAssetAtPath(matPath, typeof(Material));
                result.SharedMaterialPath = matPath;

                // Create TextureBakeResults
                AssetDatabase.CreateAsset(ScriptableObject.CreateInstance<MB2_TextureBakeResults>(), atlasAssetPath);
                MB2_TextureBakeResults textureBakeResults = (MB2_TextureBakeResults)AssetDatabase.LoadAssetAtPath(atlasAssetPath, typeof(MB2_TextureBakeResults));
                textureBaker.textureBakeResults = textureBakeResults;
                meshBaker.textureBakeResults = textureBakeResults;
                result.AtlasAssetPath = atlasAssetPath;

                AssetDatabase.Refresh();

                // Bake textures (creates the shared atlas)
                Debug.Log($"[MeshBakerService] Baking shared atlas for batch '{batchName}' ({allObjectsToCombine.Count} objects)...");
                textureBaker.CreateAtlases(null, true, new MB3_EditorMethods());

                if (textureBaker.textureBakeResults != null)
                {
                    EditorUtility.SetDirty(textureBaker.textureBakeResults);
                }

                // Cleanup result material
                CleanupResultMaterial(textureBaker.resultMaterial, settings.TexturesToIgnore);

                // Configure BatchPrefabBaker
                batchPrefabBaker.outputPrefabFolder = outputFolder;
                batchPrefabBaker.prefabRows = prefabRows.ToArray();

                // Remove empty rows
                RemoveEmptyPrefabRows(batchPrefabBaker);

                if (batchPrefabBaker.prefabRows.Length == 0)
                {
                    result.Success = true;
                    result.ErrorMessage = "No valid prefab rows after filtering";
                    return result;
                }

                // Create empty result prefabs
                Debug.Log($"[MeshBakerService] Creating output prefabs for batch '{batchName}'...");
                MB_BatchPrefabBakerEditorFunctions.CreateEmptyOutputPrefabs(batchPrefabBaker.outputPrefabFolder, batchPrefabBaker);

                // Bake all prefabs using the shared atlas
                Debug.Log($"[MeshBakerService] Baking {batchPrefabBaker.prefabRows.Length} prefabs with shared atlas...");
                MB_BatchPrefabBakerEditorFunctions.BakePrefabs(batchPrefabBaker, true);

                // Collect results and move prefabs to their original folders
                for (int i = 0; i < batchPrefabBaker.prefabRows.Length; i++)
                {
                    var row = batchPrefabBaker.prefabRows[i];
                    var originalPath = prefabInstances[i].path;
                    var prefabResult = new ProcessingResult
                    {
                        OriginalPrefabPath = originalPath,
                        Success = row.resultPrefab != null,
                        AtlasAssetPath = atlasAssetPath
                    };

                    if (row.resultPrefab != null)
                    {
                        string currentPath = AssetDatabase.GetAssetPath(row.resultPrefab);

                        // Move prefab to original folder
                        string originalFolder = Path.GetDirectoryName(originalPath);
                        string prefabName = Path.GetFileName(currentPath);
                        string targetPath = $"{originalFolder}/{prefabName}";

                        // Ensure unique path in target folder
                        targetPath = AssetDatabase.GenerateUniqueAssetPath(targetPath);

                        string moveError = AssetDatabase.MoveAsset(currentPath, targetPath);
                        if (string.IsNullOrEmpty(moveError))
                        {
                            prefabResult.BakedPrefabPath = targetPath;
                            Debug.Log($"[MeshBakerService] Moved prefab to: {targetPath}");
                        }
                        else
                        {
                            // If move failed, keep it in the output folder
                            prefabResult.BakedPrefabPath = currentPath;
                            Debug.LogWarning($"[MeshBakerService] Could not move prefab to original folder: {moveError}");
                        }
                    }
                    else
                    {
                        prefabResult.Success = false;
                        prefabResult.ErrorMessage = "Failed to bake prefab";
                    }

                    result.PrefabResults.Add(prefabResult);
                }

                result.Success = true;
                Debug.Log($"[MeshBakerService] Batch '{batchName}' complete: {result.PrefabResults.Count(r => r.Success)}/{prefabPaths.Count} prefabs succeeded");
            }
            catch (System.Exception ex)
            {
                result.Success = false;
                result.ErrorMessage = ex.Message;
                Debug.LogError($"[MeshBakerService] Error processing batch '{batchName}': {ex.Message}");
                Debug.LogException(ex);
            }
            finally
            {
                // Cleanup all instances
                foreach (var (instance, _, _) in prefabInstances)
                {
                    if (instance != null)
                    {
                        Object.DestroyImmediate(instance);
                    }
                }

                // Cleanup baker
                if (bakerGO != null)
                {
                    Object.DestroyImmediate(bakerGO);
                }

                EditorUtility.ClearProgressBar();
            }

            return result;
        }
    }
}
