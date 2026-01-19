using UnityEngine;
using UnityEditor;
using System.Collections.Generic;
using System.IO;
using DigitalOpus.MB.Core;
using DigitalOpus.MB.MBEditor;

namespace DCL.ABConverter
{
    /// <summary>
    /// Automated MeshBaker tool that simplifies the texture atlasing and prefab baking workflow.
    /// 
    /// This tool automates the following steps:
    /// 1. Creates a BatchPrefabBaker with TextureBaker and MeshBaker components
    /// 2. Collects all renderers from the dropped prefab instances
    /// 3. Configures atlas settings (2K max, 512 max tiling, Consider Mesh UVs, Keep UV2 unchanged)
    /// 4. Sets textures to ignore (_EmissionMap, _BumpMap, _MetallicGlossMap, _OcclusionMap)
    /// 5. Creates empty asset and material at the prefab root folder
    /// 6. Builds the texture atlas
    /// 7. Configures the BatchPrefabBaker output folder
    /// 8. Populates prefab rows from the TextureBaker
    /// 9. Batch bakes the prefabs
    /// </summary>
    public class AutoMeshBakerWindow : EditorWindow
    {
        // Support for multiple prefab instances
        private List<GameObject> prefabInstances = new List<GameObject>();
        private Vector2 prefabListScrollPosition;
        private bool showPrefabList = true;
        
        // For backwards compatibility - points to current prefab being processed
        private GameObject prefabInstance 
        { 
            get => currentProcessingIndex >= 0 && currentProcessingIndex < prefabInstances.Count 
                ? prefabInstances[currentProcessingIndex] 
                : (prefabInstances.Count > 0 ? prefabInstances[0] : null);
        }
        private int currentProcessingIndex = 0;
        
        private bool showAdvancedSettings = false;
        
        // Atlas settings
        private int maxAtlasSize = 2048;
        private int maxTilingBakeSize = 512;
        private bool considerMeshUVs = true;
        private MB2_LightmapOptions lightmapOption = MB2_LightmapOptions.copy_UV2_unchanged;
        
        // Texture properties to ignore
        private List<string> texturesToIgnore = new List<string>
        {
            "_EmissionMap",
            "_BumpMap",
            "_MetallicGlossMap",
            "_OcclusionMap"
        };

        private Vector2 scrollPosition;
        private string statusMessage = "";
        private MessageType statusMessageType = MessageType.None;

        [MenuItem("Decentraland/Auto MeshBaker Tool")]
        public static void ShowWindow()
        {
            var window = GetWindow<AutoMeshBakerWindow>("Auto MeshBaker");
            window.minSize = new Vector2(400, 500);
        }

        private void OnGUI()
        {
            scrollPosition = EditorGUILayout.BeginScrollView(scrollPosition);
            
            EditorGUILayout.Space(10);
            EditorGUILayout.LabelField("Auto MeshBaker Tool", EditorStyles.boldLabel);
            EditorGUILayout.HelpBox(
                "This tool automates the MeshBaker workflow:\n\n" +
                "1. Drop prefab instances from the scene (supports multiple)\n" +
                "2. Click 'Run Full Bake Process'\n\n" +
                "The tool will create atlases and baked prefab assets in the same folder as each source prefab.",
                MessageType.Info);
            
            EditorGUILayout.Space(10);
            
            // Prefab Instances list
            DrawPrefabInstancesList();
            
            // Drop zone for prefabs
            DrawDropZone();
            
            EditorGUILayout.Space(10);
            
            // Advanced settings foldout
            showAdvancedSettings = EditorGUILayout.Foldout(showAdvancedSettings, "Advanced Settings", true);
            if (showAdvancedSettings)
            {
                EditorGUI.indentLevel++;
                DrawAdvancedSettings();
                EditorGUI.indentLevel--;
            }
            
            EditorGUILayout.Space(20);
            
            // Action buttons
            DrawActionButtons();
            
            // Status message
            if (!string.IsNullOrEmpty(statusMessage))
            {
                EditorGUILayout.Space(10);
                EditorGUILayout.HelpBox(statusMessage, statusMessageType);
            }
            
            EditorGUILayout.EndScrollView();
        }
        
        private void DrawPrefabInstancesList()
        {
            EditorGUILayout.BeginHorizontal();
            showPrefabList = EditorGUILayout.Foldout(showPrefabList, $"Prefab Instances ({prefabInstances.Count})", true);
            
            if (GUILayout.Button("Clear All", GUILayout.Width(70)))
            {
                prefabInstances.Clear();
            }
            
            if (GUILayout.Button("+ Add", GUILayout.Width(50)))
            {
                prefabInstances.Add(null);
            }
            EditorGUILayout.EndHorizontal();
            
            if (showPrefabList && prefabInstances.Count > 0)
            {
                EditorGUI.indentLevel++;
                
                // Scrollable list if many prefabs
                float listHeight = Mathf.Min(prefabInstances.Count * 22f, 150f);
                prefabListScrollPosition = EditorGUILayout.BeginScrollView(prefabListScrollPosition, GUILayout.Height(listHeight));
                
                for (int i = 0; i < prefabInstances.Count; i++)
                {
                    EditorGUILayout.BeginHorizontal();
                    
                    prefabInstances[i] = (GameObject)EditorGUILayout.ObjectField(
                        $"[{i}]",
                        prefabInstances[i],
                        typeof(GameObject),
                        true);
                    
                    if (GUILayout.Button("-", GUILayout.Width(25)))
                    {
                        prefabInstances.RemoveAt(i);
                        i--;
                    }
                    
                    EditorGUILayout.EndHorizontal();
                }
                
                EditorGUILayout.EndScrollView();
                EditorGUI.indentLevel--;
            }
        }

        private void DrawDropZone()
        {
            EditorGUILayout.Space(5);
            
            Rect dropArea = GUILayoutUtility.GetRect(0, 50, GUILayout.ExpandWidth(true));
            GUI.Box(dropArea, "Drag & Drop Prefab Instances Here (supports multiple)", EditorStyles.helpBox);
            
            Event evt = Event.current;
            switch (evt.type)
            {
                case EventType.DragUpdated:
                case EventType.DragPerform:
                    if (!dropArea.Contains(evt.mousePosition))
                        break;
                    
                    DragAndDrop.visualMode = DragAndDropVisualMode.Copy;
                    
                    if (evt.type == EventType.DragPerform)
                    {
                        DragAndDrop.AcceptDrag();
                        
                        int addedCount = 0;
                        foreach (Object draggedObject in DragAndDrop.objectReferences)
                        {
                            if (draggedObject is GameObject go)
                            {
                                // Avoid duplicates
                                if (!prefabInstances.Contains(go))
                                {
                                    prefabInstances.Add(go);
                                    addedCount++;
                                }
                            }
                        }
                        
                        if (addedCount > 0)
                        {
                            Debug.Log($"[AutoMeshBaker] Added {addedCount} prefab instance(s). Total: {prefabInstances.Count}");
                        }
                    }
                    evt.Use();
                    break;
            }
        }

        private void DrawAdvancedSettings()
        {
            EditorGUILayout.LabelField("Atlas Settings", EditorStyles.miniBoldLabel);
            maxAtlasSize = EditorGUILayout.IntPopup("Max Atlas Size", maxAtlasSize, 
                new string[] { "512", "1024", "2048", "4096" }, 
                new int[] { 512, 1024, 2048, 4096 });
            maxTilingBakeSize = EditorGUILayout.IntPopup("Max Tiling Bake Size", maxTilingBakeSize,
                new string[] { "128", "256", "512", "1024" },
                new int[] { 128, 256, 512, 1024 });
            considerMeshUVs = EditorGUILayout.Toggle("Consider Mesh UVs", considerMeshUVs);
            lightmapOption = (MB2_LightmapOptions)EditorGUILayout.EnumPopup("UV2 Option", lightmapOption);
            
            EditorGUILayout.Space(5);
            EditorGUILayout.LabelField("Textures To Ignore", EditorStyles.miniBoldLabel);
            
            for (int i = 0; i < texturesToIgnore.Count; i++)
            {
                EditorGUILayout.BeginHorizontal();
                texturesToIgnore[i] = EditorGUILayout.TextField(texturesToIgnore[i]);
                if (GUILayout.Button("-", GUILayout.Width(25)))
                {
                    texturesToIgnore.RemoveAt(i);
                    i--;
                }
                EditorGUILayout.EndHorizontal();
            }
            
            if (GUILayout.Button("Add Texture Property To Ignore"))
            {
                texturesToIgnore.Add("_NewProperty");
            }
        }

        private void DrawActionButtons()
        {
            // Remove null entries from the list
            prefabInstances.RemoveAll(p => p == null);
            
            bool hasValidPrefabs = prefabInstances.Count > 0;
            
            EditorGUI.BeginDisabledGroup(!hasValidPrefabs);
            
            Color originalColor = GUI.backgroundColor;
            GUI.backgroundColor = new Color(0.6f, 0.9f, 0.6f);
            
            string buttonText = prefabInstances.Count > 1 
                ? $"Run Full Bake Process ({prefabInstances.Count} prefabs)" 
                : "Run Full Bake Process";
            
            if (GUILayout.Button(buttonText, GUILayout.Height(40)))
            {
                RunFullBakeProcess();
            }
            
            GUI.backgroundColor = originalColor;
            
            EditorGUILayout.Space(5);
            
            EditorGUILayout.LabelField("Or run individual steps (processes all prefabs):", EditorStyles.miniLabel);
            
            EditorGUILayout.BeginHorizontal();
            if (GUILayout.Button("1. Setup Baker"))
            {
                SetupBaker();
            }
            if (GUILayout.Button("2. Bake Textures"))
            {
                BakeTextures();
            }
            EditorGUILayout.EndHorizontal();
            
            EditorGUILayout.BeginHorizontal();
            if (GUILayout.Button("3. Setup Prefab Baker"))
            {
                SetupPrefabBaker();
            }
            if (GUILayout.Button("4. Bake Prefabs"))
            {
                BakePrefabs();
            }
            EditorGUILayout.EndHorizontal();
            
            if (GUILayout.Button("5. Rename Originals to _original"))
            {
                RenameAllOriginalPrefabs();
            }
            
            EditorGUI.EndDisabledGroup();
        }

        private void RunFullBakeProcess()
        {
            if (prefabInstances.Count == 0)
            {
                SetStatus("No prefab instances to process.", MessageType.Warning);
                return;
            }
            
            int successCount = 0;
            int failCount = 0;
            int totalPrefabs = prefabInstances.Count;
            
            try
            {
                SetStatus($"Starting full bake process for {totalPrefabs} prefab(s)...", MessageType.Info);
                
                // Process each prefab
                for (int i = 0; i < prefabInstances.Count; i++)
                {
                    currentProcessingIndex = i;
                    GameObject currentPrefab = prefabInstances[i];
                    
                    if (currentPrefab == null)
                    {
                        Debug.LogWarning($"[AutoMeshBaker] Skipping null prefab at index {i}");
                        failCount++;
                        continue;
                    }
                    
                    string prefabName = currentPrefab.name;
                    SetStatus($"Processing prefab {i + 1}/{totalPrefabs}: {prefabName}", MessageType.Info);
                    Debug.Log($"[AutoMeshBaker] ========== Processing prefab {i + 1}/{totalPrefabs}: {prefabName} ==========");
                    
                    try
                    {
                        // Step 1: Setup
                        var bakerGO = SetupBaker();
                        if (bakerGO == null)
                        {
                            Debug.LogError($"[AutoMeshBaker] Failed to setup baker for {prefabName}");
                            failCount++;
                            continue;
                        }
                        
                        // Step 2: Bake Textures
                        if (!BakeTextures())
                        {
                            Debug.LogError($"[AutoMeshBaker] Failed to bake textures for {prefabName}");
                            failCount++;
                            // Clean up the baker object
                            if (bakerGO != null) DestroyImmediate(bakerGO);
                            continue;
                        }
                        
                        // Step 3: Setup Prefab Baker
                        if (!SetupPrefabBaker())
                        {
                            Debug.LogError($"[AutoMeshBaker] Failed to setup prefab baker for {prefabName}");
                            failCount++;
                            if (bakerGO != null) DestroyImmediate(bakerGO);
                            continue;
                        }
                        
                        // Step 4: Bake Prefabs
                        if (!BakePrefabs())
                        {
                            Debug.LogError($"[AutoMeshBaker] Failed to bake prefabs for {prefabName}");
                            failCount++;
                            if (bakerGO != null) DestroyImmediate(bakerGO);
                            continue;
                        }
                        
                        // Step 5: Rename original prefab to {name}_original
                        RenameOriginalPrefab();
                        
                        // Clean up the baker object after successful processing
                        if (bakerGO != null) DestroyImmediate(bakerGO);
                        
                        successCount++;
                        Debug.Log($"[AutoMeshBaker] Successfully processed {prefabName}");
                    }
                    catch (System.Exception ex)
                    {
                        Debug.LogError($"[AutoMeshBaker] Error processing {prefabName}: {ex.Message}");
                        Debug.LogException(ex);
                        failCount++;
                    }
                }
                
                // Final status
                currentProcessingIndex = 0;
                string finalMessage = $"Bake process completed: {successCount} succeeded, {failCount} failed out of {totalPrefabs} prefabs.";
                if (failCount > 0)
                {
                    SetStatus(finalMessage, MessageType.Warning);
                }
                else
                {
                    SetStatus(finalMessage, MessageType.Info);
                }
            }
            catch (System.Exception ex)
            {
                SetStatus($"Error during bake process: {ex.Message}", MessageType.Error);
                Debug.LogException(ex);
            }
            finally
            {
                EditorUtility.ClearProgressBar();
                currentProcessingIndex = 0;
            }
        }
        
        /// <summary>
        /// Renames all original prefabs in the list to {name}_original.
        /// </summary>
        private void RenameAllOriginalPrefabs()
        {
            for (int i = 0; i < prefabInstances.Count; i++)
            {
                currentProcessingIndex = i;
                if (prefabInstances[i] != null)
                {
                    RenameOriginalPrefab();
                }
            }
            currentProcessingIndex = 0;
        }

        private GameObject SetupBaker()
        {
            if (prefabInstance == null)
            {
                SetStatus("Please assign a prefab instance first.", MessageType.Warning);
                return null;
            }
            
            // Get the source prefab
            GameObject sourcePrefab = PrefabUtility.GetCorrespondingObjectFromSource(prefabInstance);
            if (sourcePrefab == null)
            {
                SetStatus("The selected object is not a prefab instance.", MessageType.Error);
                return null;
            }
            
            string prefabPath = AssetDatabase.GetAssetPath(sourcePrefab);
            string prefabFolder = Path.GetDirectoryName(prefabPath);
            string prefabName = Path.GetFileNameWithoutExtension(prefabPath);
            
            // Create the BatchPrefabBaker hierarchy
            GameObject bakerGO = new GameObject($"AutoBaker_{prefabName}");
            bakerGO.transform.position = Vector3.zero;
            
            // Add components
            MB3_BatchPrefabBaker batchPrefabBaker = bakerGO.AddComponent<MB3_BatchPrefabBaker>();
            MB3_TextureBaker textureBaker = bakerGO.AddComponent<MB3_TextureBaker>();
            MB3_MeshBaker meshBaker = bakerGO.AddComponent<MB3_MeshBaker>();
            
            // Configure Texture Baker
            textureBaker.maxAtlasSize = maxAtlasSize;
            textureBaker.maxTilingBakeSize = maxTilingBakeSize;
            textureBaker.fixOutOfBoundsUVs = considerMeshUVs;
            textureBaker.packingAlgorithm = MB2_PackingAlgorithmEnum.MeshBakerTexturePacker;
            
            // Set textures to ignore
            textureBaker.texturePropNamesToIgnore.Clear();
            textureBaker.texturePropNamesToIgnore.AddRange(texturesToIgnore);
            
            // Configure Mesh Baker
            meshBaker.meshCombiner.settings.lightmapOption = lightmapOption;
            meshBaker.meshCombiner.outputOption = MB2_OutputOptions.bakeMeshAssetsInPlace;
            
            // Collect all renderers from the prefab instance
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
                SetStatus("No renderers found in the prefab instance.", MessageType.Error);
                DestroyImmediate(bakerGO);
                return null;
            }
            
            // Add objects to texture baker
            textureBaker.GetObjectsToCombine().Clear();
            textureBaker.GetObjectsToCombine().AddRange(objectsToCombine);
            
            // Create empty assets for the combined material
            string assetBasePath = $"{prefabFolder}/{prefabName}_Atlas";
            string assetPath = AssetDatabase.GenerateUniqueAssetPath($"{assetBasePath}.asset");
            string matPath = AssetDatabase.GenerateUniqueAssetPath($"{assetBasePath}_mat.mat");
            
            // Create material based on first renderer's material
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
            
            if (newMat == null)
            {
                newMat = new Material(Shader.Find("Standard"));
            }
            
            AssetDatabase.CreateAsset(newMat, matPath);
            textureBaker.resultMaterial = (Material)AssetDatabase.LoadAssetAtPath(matPath, typeof(Material));
            
            // Create TextureBakeResults asset
            AssetDatabase.CreateAsset(ScriptableObject.CreateInstance<MB2_TextureBakeResults>(), assetPath);
            textureBaker.textureBakeResults = (MB2_TextureBakeResults)AssetDatabase.LoadAssetAtPath(assetPath, typeof(MB2_TextureBakeResults));
            
            AssetDatabase.Refresh();
            
            // Configure BatchPrefabBaker
            batchPrefabBaker.outputPrefabFolder = prefabFolder;
            batchPrefabBaker.prefabRows = new MB3_BatchPrefabBaker.MB3_PrefabBakerRow[0];
            
            // Select the created baker
            Selection.activeGameObject = bakerGO;
            
            SetStatus($"Baker setup complete. Found {objectsToCombine.Count} renderers.", MessageType.Info);
            Debug.Log($"[AutoMeshBaker] Created baker with {objectsToCombine.Count} renderers from {prefabName}");
            
            return bakerGO;
        }

        private bool BakeTextures()
        {
            MB3_TextureBaker textureBaker = FindTextureBaker();
            if (textureBaker == null)
            {
                SetStatus("No TextureBaker found. Please run Setup Baker first.", MessageType.Error);
                return false;
            }
            
            if (textureBaker.textureBakeResults == null)
            {
                SetStatus("TextureBakeResults not set. Please run Setup Baker first.", MessageType.Error);
                return false;
            }
            
            SetStatus("Baking textures...", MessageType.Info);
            
            // Bake the textures
            textureBaker.CreateAtlases(UpdateProgress, true, new MB3_EditorMethods());
            EditorUtility.ClearProgressBar();
            
            if (textureBaker.textureBakeResults != null)
            {
                EditorUtility.SetDirty(textureBaker.textureBakeResults);
            }
            
            // Post-process the result material to fix ignored texture properties
            CleanupResultMaterial(textureBaker);
            
            SetStatus("Texture baking complete!", MessageType.Info);
            Debug.Log("[AutoMeshBaker] Texture baking completed");
            
            return true;
        }
        
        /// <summary>
        /// Cleans up the result material after texture baking.
        /// Resets properties for ignored textures to sensible defaults to prevent visual issues
        /// like overly bright emission or incorrect metallic/smoothness values.
        /// </summary>
        private void CleanupResultMaterial(MB3_TextureBaker textureBaker)
        {
            Material resultMat = textureBaker.resultMaterial;
            if (resultMat == null)
            {
                Debug.LogWarning("[AutoMeshBaker] No result material found to cleanup");
                return;
            }
            
            List<string> ignoredProps = textureBaker.texturePropNamesToIgnore;
            if (ignoredProps == null || ignoredProps.Count == 0)
            {
                return;
            }
            
            Debug.Log($"[AutoMeshBaker] Cleaning up result material for ignored properties: {string.Join(", ", ignoredProps)}");
            
            foreach (string prop in ignoredProps)
            {
                CleanupMaterialProperty(resultMat, prop);
            }
            
            EditorUtility.SetDirty(resultMat);
            AssetDatabase.SaveAssets();
        }
        
        /// <summary>
        /// Resets a specific material property to sensible defaults based on the property name.
        /// </summary>
        private void CleanupMaterialProperty(Material mat, string propertyName)
        {
            switch (propertyName)
            {
                case "_EmissionMap":
                    // Disable emission completely
                    if (mat.HasProperty("_EmissionColor"))
                    {
                        mat.SetColor("_EmissionColor", Color.black);
                    }
                    if (mat.HasProperty("_EmissionMap"))
                    {
                        mat.SetTexture("_EmissionMap", null);
                    }
                    // Disable emission keyword
                    mat.DisableKeyword("_EMISSION");
                    // Set emission global illumination flags
                    mat.globalIlluminationFlags = MaterialGlobalIlluminationFlags.EmissiveIsBlack;
                    Debug.Log("[AutoMeshBaker] Disabled emission on result material");
                    break;
                    
                case "_BumpMap":
                case "_NormalMap":
                case "_Normal":
                    // Clear normal map and disable normal mapping
                    if (mat.HasProperty("_BumpMap"))
                    {
                        mat.SetTexture("_BumpMap", null);
                    }
                    if (mat.HasProperty("_NormalMap"))
                    {
                        mat.SetTexture("_NormalMap", null);
                    }
                    if (mat.HasProperty("_BumpScale"))
                    {
                        mat.SetFloat("_BumpScale", 1.0f);
                    }
                    mat.DisableKeyword("_NORMALMAP");
                    Debug.Log("[AutoMeshBaker] Cleared normal map on result material");
                    break;
                    
                case "_MetallicGlossMap":
                    // Clear metallic map and set default metallic/smoothness values
                    if (mat.HasProperty("_MetallicGlossMap"))
                    {
                        mat.SetTexture("_MetallicGlossMap", null);
                    }
                    if (mat.HasProperty("_Metallic"))
                    {
                        mat.SetFloat("_Metallic", 0f);
                    }
                    if (mat.HasProperty("_Glossiness"))
                    {
                        mat.SetFloat("_Glossiness", 0.5f);
                    }
                    if (mat.HasProperty("_Smoothness"))
                    {
                        mat.SetFloat("_Smoothness", 0.5f);
                    }
                    mat.DisableKeyword("_METALLICGLOSSMAP");
                    Debug.Log("[AutoMeshBaker] Cleared metallic/gloss map on result material");
                    break;
                    
                case "_OcclusionMap":
                    // Clear occlusion map
                    if (mat.HasProperty("_OcclusionMap"))
                    {
                        mat.SetTexture("_OcclusionMap", null);
                    }
                    if (mat.HasProperty("_OcclusionStrength"))
                    {
                        mat.SetFloat("_OcclusionStrength", 1.0f);
                    }
                    Debug.Log("[AutoMeshBaker] Cleared occlusion map on result material");
                    break;
                    
                case "_ParallaxMap":
                    if (mat.HasProperty("_ParallaxMap"))
                    {
                        mat.SetTexture("_ParallaxMap", null);
                    }
                    if (mat.HasProperty("_Parallax"))
                    {
                        mat.SetFloat("_Parallax", 0.02f);
                    }
                    mat.DisableKeyword("_PARALLAXMAP");
                    Debug.Log("[AutoMeshBaker] Cleared parallax map on result material");
                    break;
                    
                case "_DetailMask":
                case "_DetailAlbedoMap":
                case "_DetailNormalMap":
                    if (mat.HasProperty("_DetailMask"))
                    {
                        mat.SetTexture("_DetailMask", null);
                    }
                    if (mat.HasProperty("_DetailAlbedoMap"))
                    {
                        mat.SetTexture("_DetailAlbedoMap", null);
                    }
                    if (mat.HasProperty("_DetailNormalMap"))
                    {
                        mat.SetTexture("_DetailNormalMap", null);
                    }
                    mat.DisableKeyword("_DETAIL_MULX2");
                    Debug.Log("[AutoMeshBaker] Cleared detail maps on result material");
                    break;
                    
                default:
                    // For unknown properties, just try to clear the texture
                    if (mat.HasProperty(propertyName))
                    {
                        mat.SetTexture(propertyName, null);
                        Debug.Log($"[AutoMeshBaker] Cleared texture property {propertyName} on result material");
                    }
                    break;
            }
        }

        private bool SetupPrefabBaker()
        {
            MB3_BatchPrefabBaker batchPrefabBaker = FindBatchPrefabBaker();
            MB3_TextureBaker textureBaker = FindTextureBaker();
            
            if (batchPrefabBaker == null || textureBaker == null)
            {
                SetStatus("No BatchPrefabBaker or TextureBaker found. Please run Setup Baker first.", MessageType.Error);
                return false;
            }
            
            // Get source prefab
            GameObject sourcePrefab = PrefabUtility.GetCorrespondingObjectFromSource(prefabInstance);
            if (sourcePrefab == null)
            {
                SetStatus("Could not find source prefab.", MessageType.Error);
                return false;
            }
            
            string prefabPath = AssetDatabase.GetAssetPath(sourcePrefab);
            string prefabFolder = Path.GetDirectoryName(prefabPath);
            
            // Set output folder
            batchPrefabBaker.outputPrefabFolder = prefabFolder;
            
            // Populate prefab rows from texture baker
            PopulatePrefabRowsFromTextureBaker(batchPrefabBaker, textureBaker);
            
            // Create empty result prefabs
            MB_BatchPrefabBakerEditorFunctions.CreateEmptyOutputPrefabs(batchPrefabBaker.outputPrefabFolder, batchPrefabBaker);
            
            SetStatus("Prefab baker setup complete.", MessageType.Info);
            Debug.Log("[AutoMeshBaker] Prefab baker setup completed");
            
            return true;
        }

        private bool BakePrefabs()
        {
            MB3_BatchPrefabBaker batchPrefabBaker = FindBatchPrefabBaker();
            
            if (batchPrefabBaker == null)
            {
                SetStatus("No BatchPrefabBaker found. Please run Setup Baker first.", MessageType.Error);
                return false;
            }
            
            // Clean up any empty rows before baking
            RemoveEmptyPrefabRows(batchPrefabBaker);
            
            if (batchPrefabBaker.prefabRows == null || batchPrefabBaker.prefabRows.Length == 0)
            {
                SetStatus("No prefab rows to bake. Please run Setup Prefab Baker first.", MessageType.Error);
                return false;
            }
            
            SetStatus("Baking prefabs...", MessageType.Info);
            
            // Bake prefabs (replace prefab mode)
            MB_BatchPrefabBakerEditorFunctions.BakePrefabs(batchPrefabBaker, true);
            
            SetStatus("Prefab baking complete!", MessageType.Info);
            Debug.Log("[AutoMeshBaker] Prefab baking completed");
            
            return true;
        }
        
        /// <summary>
        /// Renames the original source prefab to {name}_original after baking.
        /// This preserves the original prefab while allowing the baked result to potentially take its place.
        /// </summary>
        private void RenameOriginalPrefab()
        {
            if (prefabInstance == null)
            {
                Debug.LogWarning("[AutoMeshBaker] No prefab instance set, cannot rename original prefab");
                return;
            }
            
            GameObject sourcePrefab = PrefabUtility.GetCorrespondingObjectFromSource(prefabInstance);
            if (sourcePrefab == null)
            {
                Debug.LogWarning("[AutoMeshBaker] Could not find source prefab to rename");
                return;
            }
            
            string originalPath = AssetDatabase.GetAssetPath(sourcePrefab);
            if (string.IsNullOrEmpty(originalPath))
            {
                Debug.LogWarning("[AutoMeshBaker] Could not get path for source prefab");
                return;
            }
            
            string directory = Path.GetDirectoryName(originalPath);
            string fileName = Path.GetFileNameWithoutExtension(originalPath);
            string extension = Path.GetExtension(originalPath);
            
            // Check if already renamed (ends with _original)
            if (fileName.EndsWith("_original"))
            {
                Debug.Log($"[AutoMeshBaker] Prefab already renamed: {originalPath}");
                return;
            }
            
            string newFileName = $"{fileName}_original";
            string newPath = Path.Combine(directory, $"{newFileName}{extension}");
            
            // Make sure the new path doesn't already exist
            newPath = AssetDatabase.GenerateUniqueAssetPath(newPath);
            
            // Rename the asset
            string error = AssetDatabase.RenameAsset(originalPath, newFileName);
            
            if (string.IsNullOrEmpty(error))
            {
                Debug.Log($"[AutoMeshBaker] Renamed original prefab: {originalPath} -> {newPath}");
                SetStatus($"Renamed original prefab to {newFileName}", MessageType.Info);
                AssetDatabase.Refresh();
            }
            else
            {
                Debug.LogError($"[AutoMeshBaker] Failed to rename prefab: {error}");
                SetStatus($"Failed to rename original prefab: {error}", MessageType.Warning);
            }
        }
        
        /// <summary>
        /// Removes any prefab rows where the sourcePrefab is null.
        /// This prevents the "Source Prefab on row X is not set" error.
        /// </summary>
        private void RemoveEmptyPrefabRows(MB3_BatchPrefabBaker batchPrefabBaker)
        {
            if (batchPrefabBaker.prefabRows == null) return;
            
            List<MB3_BatchPrefabBaker.MB3_PrefabBakerRow> validRows = new List<MB3_BatchPrefabBaker.MB3_PrefabBakerRow>();
            
            for (int i = 0; i < batchPrefabBaker.prefabRows.Length; i++)
            {
                var row = batchPrefabBaker.prefabRows[i];
                if (row != null && row.sourcePrefab != null)
                {
                    validRows.Add(row);
                }
                else
                {
                    Debug.Log($"[AutoMeshBaker] Removed empty prefab row at index {i}");
                }
            }
            
            if (validRows.Count != batchPrefabBaker.prefabRows.Length)
            {
                Undo.RecordObject(batchPrefabBaker, "Remove empty prefab rows");
                batchPrefabBaker.prefabRows = validRows.ToArray();
                Debug.Log($"[AutoMeshBaker] Cleaned up prefab rows: {batchPrefabBaker.prefabRows.Length} valid rows remaining");
            }
        }

        private void PopulatePrefabRowsFromTextureBaker(MB3_BatchPrefabBaker batchPrefabBaker, MB3_TextureBaker textureBaker)
        {
            List<GameObject> newPrefabs = new List<GameObject>();
            List<GameObject> gos = textureBaker.GetObjectsToCombine();
            
            for (int i = 0; i < gos.Count; i++)
            {
                if (gos[i] == null) continue;
                
                GameObject go = MBVersionEditor.PrefabUtility_FindPrefabRoot(gos[i]);
                if (go == null) continue;
                
                Object obj = MBVersionEditor.PrefabUtility_GetCorrespondingObjectFromSource(go);
                
                if (obj != null && obj is GameObject prefab)
                {
                    if (!newPrefabs.Contains(prefab))
                    {
                        newPrefabs.Add(prefab);
                    }
                }
            }
            
            // First, collect existing valid rows (remove empty rows where sourcePrefab is null)
            List<MB3_BatchPrefabBaker.MB3_PrefabBakerRow> existingValidRows = new List<MB3_BatchPrefabBaker.MB3_PrefabBakerRow>();
            if (batchPrefabBaker.prefabRows != null)
            {
                for (int i = 0; i < batchPrefabBaker.prefabRows.Length; i++)
                {
                    if (batchPrefabBaker.prefabRows[i] != null && 
                        batchPrefabBaker.prefabRows[i].sourcePrefab != null)
                    {
                        existingValidRows.Add(batchPrefabBaker.prefabRows[i]);
                    }
                }
            }
            
            // Remove prefabs that are already in the existing valid rows
            List<GameObject> prefabsToAdd = new List<GameObject>();
            for (int i = 0; i < newPrefabs.Count; i++)
            {
                bool found = false;
                for (int j = 0; j < existingValidRows.Count; j++)
                {
                    if (existingValidRows[j].sourcePrefab == newPrefabs[i])
                    {
                        found = true;
                        break;
                    }
                }
                
                if (!found)
                {
                    prefabsToAdd.Add(newPrefabs[i]);
                }
            }
            
            // Create the final rows list - start with existing valid rows
            List<MB3_BatchPrefabBaker.MB3_PrefabBakerRow> finalRows = new List<MB3_BatchPrefabBaker.MB3_PrefabBakerRow>();
            finalRows.AddRange(existingValidRows);
            
            // Add new rows for prefabs that weren't already present
            for (int i = 0; i < prefabsToAdd.Count; i++)
            {
                MB3_BatchPrefabBaker.MB3_PrefabBakerRow row = new MB3_BatchPrefabBaker.MB3_PrefabBakerRow();
                row.sourcePrefab = prefabsToAdd[i];
                finalRows.Add(row);
            }
            
            // Remove any remaining empty rows (final safety check)
            finalRows.RemoveAll(row => row == null || row.sourcePrefab == null);
            
            Undo.RecordObject(batchPrefabBaker, "Populate prefab rows");
            batchPrefabBaker.prefabRows = finalRows.ToArray();
            
            Debug.Log($"[AutoMeshBaker] Populated {finalRows.Count} prefab rows (removed empty rows)");
        }

        private MB3_TextureBaker FindTextureBaker()
        {
            // First check if there's a selected baker in the scene
            if (Selection.activeGameObject != null)
            {
                MB3_TextureBaker selected = Selection.activeGameObject.GetComponent<MB3_TextureBaker>();
                if (selected != null) return selected;
            }
            
            // Find any AutoBaker in the scene
            MB3_TextureBaker[] bakers = FindObjectsOfType<MB3_TextureBaker>();
            foreach (var baker in bakers)
            {
                if (baker.gameObject.name.StartsWith("AutoBaker_"))
                {
                    return baker;
                }
            }
            
            return bakers.Length > 0 ? bakers[0] : null;
        }

        private MB3_BatchPrefabBaker FindBatchPrefabBaker()
        {
            // First check if there's a selected baker in the scene
            if (Selection.activeGameObject != null)
            {
                MB3_BatchPrefabBaker selected = Selection.activeGameObject.GetComponent<MB3_BatchPrefabBaker>();
                if (selected != null) return selected;
            }
            
            // Find any AutoBaker in the scene
            MB3_BatchPrefabBaker[] bakers = FindObjectsOfType<MB3_BatchPrefabBaker>();
            foreach (var baker in bakers)
            {
                if (baker.gameObject.name.StartsWith("AutoBaker_"))
                {
                    return baker;
                }
            }
            
            return bakers.Length > 0 ? bakers[0] : null;
        }

        private void UpdateProgress(string msg, float progress)
        {
            EditorUtility.DisplayProgressBar("Auto MeshBaker", msg, progress);
        }

        private void SetStatus(string message, MessageType type)
        {
            statusMessage = message;
            statusMessageType = type;
            
            switch (type)
            {
                case MessageType.Error:
                    Debug.LogError($"[AutoMeshBaker] {message}");
                    break;
                case MessageType.Warning:
                    Debug.LogWarning($"[AutoMeshBaker] {message}");
                    break;
                default:
                    Debug.Log($"[AutoMeshBaker] {message}");
                    break;
            }
            
            Repaint();
        }
    }
}

