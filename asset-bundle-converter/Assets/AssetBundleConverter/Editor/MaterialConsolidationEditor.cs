using System.Collections.Generic;
using System.IO;
using System.Linq;
using UnityEditor;
using UnityEngine;
using Object = UnityEngine.Object;

namespace DCL.ABConverter.Editor
{
    public class MaterialConsolidationEditor : EditorWindow
    {
        private static readonly string SHARED_TEXTURES_FOLDER = "Assets/_Downloaded/_ReusedTextures/";
        private static readonly string SHARED_MATERIALS_FOLDER = "Assets/_Downloaded/_ReusedMaterial/";

        private bool includeAllAssets = true;
        private string specificFolder = "Assets/_Downloaded/";
        private Vector2 scrollPosition;
        private string lastResult = "";

        [MenuItem("Decentraland/Consolidate Materials and Textures")]
        public static void ShowWindow()
        {
            var window = GetWindow<MaterialConsolidationEditor>("Material Consolidation");
            window.minSize = new Vector2(400, 300);
            window.Show();
        }

        [MenuItem("Decentraland/Quick Consolidate (All Assets)")]
        public static void QuickConsolidate()
        {
            if (EditorUtility.DisplayDialog("Consolidate Materials",
                "This will consolidate all materials and textures from GLB/GLTF assets into shared folders. Continue?",
                "Yes", "Cancel"))
            {
                ConsolidateMaterialsAndTextures("Assets/_Downloaded/", true);
            }
        }

        private void OnGUI()
        {
            GUILayout.Label("Material and Texture Consolidation", EditorStyles.boldLabel);
            EditorGUILayout.Space();

            EditorGUILayout.HelpBox(
                "This tool consolidates duplicate materials and textures across all GLB/GLTF assets.\n" +
                "All unique materials will be moved to: " + SHARED_MATERIALS_FOLDER + "\n" +
                "All unique textures will be moved to: " + SHARED_TEXTURES_FOLDER,
                MessageType.Info);

            EditorGUILayout.Space();

            includeAllAssets = EditorGUILayout.Toggle("Search All Assets", includeAllAssets);

            if (!includeAllAssets)
            {
                EditorGUILayout.BeginHorizontal();
                EditorGUILayout.LabelField("Specific Folder:", GUILayout.Width(100));
                specificFolder = EditorGUILayout.TextField(specificFolder);
                if (GUILayout.Button("Browse", GUILayout.Width(60)))
                {
                    string path = EditorUtility.OpenFolderPanel("Select Folder", "Assets", "");
                    if (!string.IsNullOrEmpty(path))
                    {
                        if (path.StartsWith(Application.dataPath))
                        {
                            specificFolder = "Assets" + path.Substring(Application.dataPath.Length);
                        }
                    }
                }
                EditorGUILayout.EndHorizontal();
            }

            EditorGUILayout.Space();

            if (GUILayout.Button("Consolidate Materials and Textures", GUILayout.Height(30)))
            {
                string searchPath = includeAllAssets ? "Assets/_Downloaded/" : specificFolder;
                ConsolidateMaterialsAndTextures(searchPath, includeAllAssets);
            }

            EditorGUILayout.Space();

            if (!string.IsNullOrEmpty(lastResult))
            {
                EditorGUILayout.LabelField("Last Result:", EditorStyles.boldLabel);
                scrollPosition = EditorGUILayout.BeginScrollView(scrollPosition);
                EditorGUILayout.TextArea(lastResult, GUILayout.ExpandHeight(true));
                EditorGUILayout.EndScrollView();
            }
        }

        private static void ConsolidateMaterialsAndTextures(string searchPath, bool recursive)
        {
            Debug.Log($"Starting material and texture consolidation in: {searchPath}");

            // Ensure shared folders exist
            if (!AssetDatabase.IsValidFolder(SHARED_TEXTURES_FOLDER))
            {
                string parentFolder = Path.GetDirectoryName(SHARED_TEXTURES_FOLDER.TrimEnd('/'));
                if (!AssetDatabase.IsValidFolder(parentFolder))
                {
                    AssetDatabase.CreateFolder("Assets", "_Downloaded");
                }
                AssetDatabase.CreateFolder(parentFolder, "_ReusedTextures");
            }

            if (!AssetDatabase.IsValidFolder(SHARED_MATERIALS_FOLDER))
            {
                string parentFolder = Path.GetDirectoryName(SHARED_MATERIALS_FOLDER.TrimEnd('/'));
                if (!AssetDatabase.IsValidFolder(parentFolder))
                {
                    AssetDatabase.CreateFolder("Assets", "_Downloaded");
                }
                AssetDatabase.CreateFolder(parentFolder, "_ReusedMaterial");
            }

            var materialCache = new Dictionary<string, Material>(); // hash -> shared material
            var textureCache = new Dictionary<string, Texture2D>(); // hash -> shared texture
            var materialPathToHash = new Dictionary<string, string>(); // material path -> hash (for replacement)

            // Find all GLB/GLTF assets
            string[] guids;
            if (recursive)
            {
                guids = AssetDatabase.FindAssets("t:GameObject", new[] { searchPath })
                    .Concat(AssetDatabase.FindAssets("t:Model", new[] { searchPath }))
                    .Distinct()
                    .ToArray();
            }
            else
            {
                guids = AssetDatabase.FindAssets("t:GameObject", new[] { searchPath })
                    .Concat(AssetDatabase.FindAssets("t:Model", new[] { searchPath }))
                    .Distinct()
                    .ToArray();
            }

            var gltfAssets = new List<GameObject>();
            foreach (string guid in guids)
            {
                string assetPath = AssetDatabase.GUIDToAssetPath(guid);
                if (assetPath.EndsWith(".glb") || assetPath.EndsWith(".gltf"))
                {
                    GameObject asset = AssetDatabase.LoadAssetAtPath<GameObject>(assetPath);
                    if (asset != null)
                        gltfAssets.Add(asset);
                }
            }

            Debug.Log($"Found {gltfAssets.Count} GLB/GLTF assets to process");

            // Step 1: Collect all materials and textures
            int totalProgress = gltfAssets.Count * 2; // Two passes
            int currentProgress = 0;

            Debug.Log($"\n=== STEP 1: ANALYZING MATERIALS ===");

            foreach (GameObject gltfObject in gltfAssets)
            {
                currentProgress++;
                EditorUtility.DisplayProgressBar("Consolidating Materials",
                    $"Analyzing {gltfObject.name}...",
                    currentProgress / (float)totalProgress);

                Debug.Log($"\nProcessing GLB: {gltfObject.name}");
                string assetPath = AssetDatabase.GetAssetPath(gltfObject);
                Debug.Log($"  Path: {assetPath}");

                var renderers = gltfObject.GetComponentsInChildren<Renderer>(true);
                Debug.Log($"  Found {renderers.Length} renderers");

                foreach (var renderer in renderers)
                {
                    var materials = renderer.sharedMaterials;
                    Debug.Log($"    Renderer '{renderer.name}' has {materials.Length} materials");

                    foreach (Material mat in materials)
                    {
                        if (mat == null)
                        {
                            Debug.LogWarning($"      NULL material found!");
                            continue;
                        }

                        string matPath = AssetDatabase.GetAssetPath(mat);
                        if (string.IsNullOrEmpty(matPath))
                        {
                            Debug.LogWarning($"      Material has no asset path: {mat.name}");
                            continue;
                        }

                        // Skip if already in shared folder
                        if (matPath.Contains("_ReusedMaterial"))
                        {
                            Debug.Log($"      Material already in shared folder: {mat.name}");
                            continue;
                        }

                        Debug.Log($"      Material: {mat.name}");
                        Debug.Log($"        Path: {matPath}");
                        Debug.Log($"        Shader: {mat.shader.name}");
                        Debug.Log($"        Textures: {GetTextureCount(mat)}");

                        string matHash = ComputeMaterialHash(mat);
                        Debug.Log($"        Hash: {matHash.Substring(0, 16)}...");

                        // Track this material path for replacement
                        if (!materialPathToHash.ContainsKey(matPath))
                        {
                            materialPathToHash[matPath] = matHash;
                        }

                        if (!materialCache.ContainsKey(matHash))
                        {
                            Debug.Log($"        Creating shared material...");
                            ProcessMaterialTextures(mat, textureCache);
                            Material sharedMat = CreateSharedMaterial(mat, matHash, textureCache);
                            materialCache[matHash] = sharedMat;
                            Debug.Log($"        Created at: {AssetDatabase.GetAssetPath(sharedMat)}");
                        }
                        else
                        {
                            Debug.Log($"        Shared material already exists (reusing)");
                        }
                    }
                }
            }

            // Step 2: Replace original material files with shared materials
            Debug.Log($"\n=== STEP 2: REPLACING MATERIAL FILES ===");
            int replacedFiles = 0;

            foreach (var kvp in materialPathToHash)
            {
                string originalMatPath = kvp.Key;
                string matHash = kvp.Value;

                if (!materialCache.TryGetValue(matHash, out Material sharedMat))
                {
                    Debug.LogError($"No shared material found for hash: {matHash}");
                    continue;
                }

                string sharedMatPath = AssetDatabase.GetAssetPath(sharedMat);

                Debug.Log($"Replacing: {originalMatPath}");
                Debug.Log($"  With: {sharedMatPath}");

                // Delete and copy to replace the file
                if (AssetDatabase.DeleteAsset(originalMatPath))
                {
                    if (AssetDatabase.CopyAsset(sharedMatPath, originalMatPath))
                    {
                        replacedFiles++;
                        Debug.Log($"  Success!");
                    }
                    else
                    {
                        Debug.LogError($"  Failed to copy!");
                    }
                }
                else
                {
                    Debug.LogError($"  Failed to delete original!");
                }
            }

            Debug.Log($"\nReplaced {replacedFiles} material files");

            AssetDatabase.SaveAssets();
            AssetDatabase.Refresh();

            // Step 3: Reimport GLBs so they pick up the new materials
            Debug.Log($"\n=== STEP 3: REIMPORTING GLBs ===");
            foreach (GameObject gltfObject in gltfAssets)
            {
                string assetPath = AssetDatabase.GetAssetPath(gltfObject);
                Debug.Log($"Reimporting: {assetPath}");
                AssetDatabase.ImportAsset(assetPath, ImportAssetOptions.ForceUpdate);
            }

            // Step 4: Verify created materials and textures
            Debug.Log($"\n=== CONSOLIDATION SUMMARY ===");
            Debug.Log($"Created {materialCache.Count} unique shared materials");
            Debug.Log($"Created {textureCache.Count} unique shared textures");
            Debug.Log($"Replaced {replacedFiles} material files");

            Debug.Log($"\n=== SHARED MATERIALS ===");
            foreach (var kvp in materialCache)
            {
                string matHash = kvp.Key;
                Material sharedMat = kvp.Value;
                string matPath = AssetDatabase.GetAssetPath(sharedMat);
                int textureCount = GetTextureCount(sharedMat);

                Debug.Log($"Material: {sharedMat.name}");
                Debug.Log($"  Path: {matPath}");
                Debug.Log($"  Hash: {matHash}");
                Debug.Log($"  Textures: {textureCount}");
                Debug.Log($"  Shader: {sharedMat.shader.name}");
            }

            Debug.Log($"\n=== SHARED TEXTURES ===");
            foreach (var kvp in textureCache)
            {
                string texHash = kvp.Key;
                Texture2D tex = kvp.Value;
                string texPath = AssetDatabase.GetAssetPath(tex);

                Debug.Log($"Texture: {tex.name}");
                Debug.Log($"  Path: {texPath}");
                Debug.Log($"  Hash: {texHash.Substring(0, 8)}...");
                Debug.Log($"  Size: {tex.width}x{tex.height}");
            }

            AssetDatabase.SaveAssets();
            AssetDatabase.Refresh();

            EditorUtility.ClearProgressBar();

            string result = $"Consolidation Complete!\n\n" +
                          $"Created Unique Materials: {materialCache.Count}\n" +
                          $"Created Unique Textures: {textureCache.Count}\n" +
                          $"Material Files Replaced: {replacedFiles}\n" +
                          $"GLBs Reimported: {gltfAssets.Count}\n\n" +
                          $"Check console for detailed output.\n" +
                          $"Materials saved to: {SHARED_MATERIALS_FOLDER}\n" +
                          $"Textures saved to: {SHARED_TEXTURES_FOLDER}";

            Debug.Log(result);
            EditorUtility.DisplayDialog("Consolidation Complete", result, "OK");

            // Update the window if it's open
            var window = GetWindow<MaterialConsolidationEditor>(false, "Material Consolidation", false);
            if (window != null)
            {
                window.lastResult = result;
                window.Repaint();
            }
        }

        private static void ProcessMaterialTextures(Material mat, Dictionary<string, Texture2D> textureCache)
        {
            var shader = mat.shader;
            int propertyCount = ShaderUtil.GetPropertyCount(shader);

            Debug.Log($"          Processing textures for material '{mat.name}'");

            for (int i = 0; i < propertyCount; i++)
            {
                if (ShaderUtil.GetPropertyType(shader, i) != ShaderUtil.ShaderPropertyType.TexEnv)
                    continue;

                string propName = ShaderUtil.GetPropertyName(shader, i);
                Texture tex = mat.GetTexture(propName);
                if (tex == null || !(tex is Texture2D tex2D))
                {
                    Debug.Log($"            Property '{propName}': No texture");
                    continue;
                }

                Debug.Log($"            Property '{propName}': {tex2D.name}");

                string texHash = ComputeTextureHashSimple(tex2D);

                if (textureCache.ContainsKey(texHash))
                {
                    Debug.Log($"              Already in cache");
                    continue;
                }

                string texPath = AssetDatabase.GetAssetPath(tex2D);
                if (string.IsNullOrEmpty(texPath))
                {
                    Debug.LogWarning($"              No asset path found!");
                    continue;
                }

                Debug.Log($"              Original path: {texPath}");

                if (texPath.Contains("_ReusedTextures"))
                {
                    Debug.Log($"              Already in shared folder");
                    textureCache[texHash] = tex2D;
                    continue;
                }

                string texName = Path.GetFileNameWithoutExtension(texPath);
                string extension = Path.GetExtension(texPath);
                string newTexPath = $"{SHARED_TEXTURES_FOLDER}{texName}_{texHash.Substring(0, 8)}{extension}";

                Texture2D existingTex = AssetDatabase.LoadAssetAtPath<Texture2D>(newTexPath);
                if (existingTex != null)
                {
                    Debug.Log($"              Found existing at: {newTexPath}");
                    textureCache[texHash] = existingTex;
                    continue;
                }

                Debug.Log($"              Copying to: {newTexPath}");

                if (AssetDatabase.CopyAsset(texPath, newTexPath))
                {
                    AssetDatabase.ImportAsset(newTexPath, ImportAssetOptions.ForceUpdate);
                    Texture2D copiedTex = AssetDatabase.LoadAssetAtPath<Texture2D>(newTexPath);

                    if (copiedTex != null)
                    {
                        textureCache[texHash] = copiedTex;
                        Debug.Log($"              Copied successfully");
                    }
                    else
                    {
                        Debug.LogError($"              Failed to load copied texture from {newTexPath}");
                    }
                }
                else
                {
                    Debug.LogError($"              Failed to copy texture from {texPath} to {newTexPath}");
                }
            }
        }

        private static Material CreateSharedMaterial(Material sourceMat, string matHash, Dictionary<string, Texture2D> textureCache)
        {
            string matName = sourceMat.name.Replace(" (Instance)", "").Replace("(", "").Replace(")", "");
            string sharedMatPath = $"{SHARED_MATERIALS_FOLDER}{matName}_{matHash.Substring(0, 8)}.mat";

            Material existingMat = AssetDatabase.LoadAssetAtPath<Material>(sharedMatPath);
            if (existingMat != null)
            {
                return existingMat;
            }

            Material sharedMat = Object.Instantiate(sourceMat);
            sharedMat.name = sourceMat.name;

            var shader = sharedMat.shader;
            int propertyCount = ShaderUtil.GetPropertyCount(shader);

            for (int i = 0; i < propertyCount; i++)
            {
                if (ShaderUtil.GetPropertyType(shader, i) != ShaderUtil.ShaderPropertyType.TexEnv)
                    continue;

                string propName = ShaderUtil.GetPropertyName(shader, i);
                Texture tex = sharedMat.GetTexture(propName);
                if (tex == null || !(tex is Texture2D tex2D)) continue;

                string texHash = ComputeTextureHashSimple(tex2D);
                if (textureCache.TryGetValue(texHash, out Texture2D sharedTex))
                {
                    sharedMat.SetTexture(propName, sharedTex);
                }
            }

            AssetDatabase.CreateAsset(sharedMat, sharedMatPath);
            AssetDatabase.SaveAssets();
            EditorUtility.SetDirty(sharedMat);
            AssetDatabase.Refresh();


            return sharedMat;
        }

        private static int GetTextureCount(Material mat)
        {
            if (mat == null) return 0;

            int count = 0;
            var shader = mat.shader;
            int propertyCount = ShaderUtil.GetPropertyCount(shader);

            for (int i = 0; i < propertyCount; i++)
            {
                if (ShaderUtil.GetPropertyType(shader, i) == ShaderUtil.ShaderPropertyType.TexEnv)
                {
                    string propName = ShaderUtil.GetPropertyName(shader, i);
                    if (mat.GetTexture(propName) != null)
                        count++;
                }
            }

            return count;
        }

        private static string ComputeMaterialHash(Material mat)
        {
            using (var md5 = System.Security.Cryptography.MD5.Create())
            {
                using (var stream = new System.IO.MemoryStream())
                using (var writer = new System.IO.BinaryWriter(stream))
                {
                    writer.Write(mat.shader.name);
                    writer.Write(mat.renderQueue);

                    var shader = mat.shader;
                    int propertyCount = ShaderUtil.GetPropertyCount(shader);

                    for (int i = 0; i < propertyCount; i++)
                    {
                        string propName = ShaderUtil.GetPropertyName(shader, i);
                        var propType = ShaderUtil.GetPropertyType(shader, i);

                        writer.Write(propName);

                        switch (propType)
                        {
                            case ShaderUtil.ShaderPropertyType.Color:
                                if (mat.HasProperty(propName))
                                {
                                    var color = mat.GetColor(propName);
                                    writer.Write(color.r);
                                    writer.Write(color.g);
                                    writer.Write(color.b);
                                    writer.Write(color.a);
                                }
                                break;
                            case ShaderUtil.ShaderPropertyType.Vector:
                                if (mat.HasProperty(propName))
                                {
                                    var vec = mat.GetVector(propName);
                                    writer.Write(vec.x);
                                    writer.Write(vec.y);
                                    writer.Write(vec.z);
                                    writer.Write(vec.w);
                                }
                                break;
                            case ShaderUtil.ShaderPropertyType.Float:
                            case ShaderUtil.ShaderPropertyType.Range:
                                if (mat.HasProperty(propName))
                                {
                                    writer.Write(mat.GetFloat(propName));
                                }
                                break;
                            case ShaderUtil.ShaderPropertyType.TexEnv:
                                Texture tex = mat.GetTexture(propName);
                                if (tex != null && tex is Texture2D tex2D)
                                {
                                    writer.Write(ComputeTextureHashSimple(tex2D));

                                    var scale = mat.GetTextureScale(propName);
                                    var offset = mat.GetTextureOffset(propName);
                                    writer.Write(scale.x);
                                    writer.Write(scale.y);
                                    writer.Write(offset.x);
                                    writer.Write(offset.y);
                                }
                                break;
                        }
                    }

                    byte[] hash = md5.ComputeHash(stream.ToArray());
                    return System.BitConverter.ToString(hash).Replace("-", "").ToLowerInvariant();
                }
            }
        }

        private static string ComputeTextureHashSimple(Texture2D texture)
        {
            string texPath = AssetDatabase.GetAssetPath(texture);
            if (string.IsNullOrEmpty(texPath))
            {
                return texture.GetInstanceID().ToString();
            }

            try
            {
                byte[] fileData = File.ReadAllBytes(texPath);
                using (var md5 = System.Security.Cryptography.MD5.Create())
                {
                    byte[] hash = md5.ComputeHash(fileData);
                    return System.BitConverter.ToString(hash).Replace("-", "").ToLowerInvariant();
                }
            }
            catch
            {
                using (var md5 = System.Security.Cryptography.MD5.Create())
                {
                    byte[] pathBytes = System.Text.Encoding.UTF8.GetBytes(texPath + texture.width + texture.height + texture.format);
                    byte[] hash = md5.ComputeHash(pathBytes);
                    return System.BitConverter.ToString(hash).Replace("-", "").ToLowerInvariant();
                }
            }
        }
    }
}

