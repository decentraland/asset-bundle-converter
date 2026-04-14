using System;
using System.Collections.Generic;
using System.IO;
using System.Threading.Tasks;
using AssetBundleConverter.Editor;
using AssetBundleConverter.LODsConverter.Utils;
using DCL;
using DCL.ABConverter;
using Newtonsoft.Json;
using UnityEditor;
using UnityEngine;
using UnityEngine.Networking;
using Object = UnityEngine.Object;

public class LODConversion
{
    private static readonly int VERTICAL_CLIPPING_ID = Shader.PropertyToID("_VerticalClipping");
    private static readonly int PLANE_CLIPPING_ID = Shader.PropertyToID("_PlaneClipping");

    private readonly LODPathHandler lodPathHandler;
    private readonly string[] glbPaths;
    private readonly Shader lodShader;

    public LODConversion(string customOutputPath, string[] glbPaths)
    {
        this.glbPaths = glbPaths;
        lodPathHandler = new LODPathHandler(customOutputPath);
        lodShader = Shader.Find("DCL/Scene_TexArray");
        Debug.Log($"[LOD] LODConversion created. outputPath={customOutputPath}, glbCount={glbPaths.Length}, shader={(lodShader != null ? lodShader.name : "NULL")}");
    }

    public async Task ConvertLODs()
    {
        Debug.Log("[LOD] === ConvertLODs START ===");
        PlatformUtils.currentTarget = EditorUserBuildSettings.activeBuildTarget;
        Debug.Log($"[LOD] Build target: {EditorUserBuildSettings.activeBuildTarget}");

        IAssetDatabase assetDatabase = new UnityEditorWrappers.AssetDatabase();

        try
        {
            foreach (string glbPath in glbPaths)
            {
                Debug.Log($"[LOD] Processing: {glbPath}");
                string destPath = CopyGLBToTemp(glbPath);
                Debug.Log($"[LOD] Copied to temp: {destPath}");

                lodPathHandler.SetCurrentFile(destPath);
                Debug.Log($"[LOD] SetCurrentFile done. fileName={lodPathHandler.fileName}, fileNameNoExt={lodPathHandler.fileNameWithoutExtension}, abName={lodPathHandler.assetBundleFileName}");
                Debug.Log($"[LOD]   filePath={lodPathHandler.filePath}");
                Debug.Log($"[LOD]   fileExists={File.Exists(lodPathHandler.filePath)}");

                var parcel = await FetchParcel(lodPathHandler.fileName);
                BuildPrefab(lodPathHandler, parcel);
            }

            AssetDatabase.SaveAssets();
            AssetDatabase.Refresh();

            Debug.Log("[LOD] Assigning shader asset bundle...");
            assetDatabase.AssignAssetBundle(lodShader, false);

            Debug.Log("[LOD] Building asset bundles...");
            BuildAssetBundles(EditorUserBuildSettings.activeBuildTarget);
        }
        catch (Exception e)
        {
            Debug.LogError($"[LOD] Conversion failed: {e.Message}\n{e.StackTrace}");
            Debug.Log("[LOD] Keeping temp folder for inspection: " + lodPathHandler.tempPathRelativeToDataPath);
            // NOT deleting temp folder so you can inspect
            return;
        }

        Debug.Log("[LOD] Relocating output folder...");
        lodPathHandler.RelocateOutputFolder();

        // NOT deleting temp folder so you can inspect
        Debug.Log("[LOD] Temp folder kept at: " + lodPathHandler.tempPathRelativeToDataPath);

        foreach (string glbPath in glbPaths)
            Debug.Log($"[LOD] Asset bundle built for {Path.GetFileName(glbPath)}");

        Debug.Log("[LOD] === ConvertLODs DONE ===");
    }

    private string CopyGLBToTemp(string sourcePath)
    {
        string fileName = Path.GetFileName(sourcePath);
        string destPath = Path.Combine(lodPathHandler.tempPath, fileName);
        Debug.Log($"[LOD] CopyGLBToTemp: {sourcePath} -> {destPath}");
        Debug.Log($"[LOD]   Source exists: {File.Exists(sourcePath)}");
        File.Copy(sourcePath, destPath, true);
        Debug.Log($"[LOD]   Dest exists after copy: {File.Exists(destPath)}");
        AssetDatabase.Refresh();
        return destPath;
    }

    private async Task<Parcel> FetchParcel(string fileNameWithLODLevel)
    {
        string hash = fileNameWithLODLevel.Split('_')[0];
        string url = "https://peer.decentraland.org/content/entities/active/";

        Debug.Log($"[LOD] Fetching parcel for hash: {hash}");

        using (var request = UnityWebRequest.Post(url, "{\"ids\":[\"" + hash + "\"]}", "application/json"))
        {
            await request.SendWebRequest();

            if (request.result == UnityWebRequest.Result.Success)
            {
                var parcelData = JsonConvert.DeserializeObject<Parcel[]>(request.downloadHandler.text);
                Debug.Log($"[LOD] Parcel fetched: {parcelData[0].GetDecodedParcels().Count} parcels");
                return parcelData[0];
            }
            else
            {
                Debug.LogWarning($"[LOD] Failed to fetch parcel for {hash}: {request.error}. Clipping will be zeroed.");
                return null;
            }
        }
    }

    private void ConfigureGltfImporter(LODPathHandler pathHandler)
    {
        Debug.Log($"[LOD] ConfigureGltfImporter at: {pathHandler.filePathRelativeToDataPath}");
        AssetDatabase.SetImporterOverride<GLTFast.Editor.GltfImporter>(pathHandler.filePathRelativeToDataPath);
        AssetDatabase.ImportAsset(pathHandler.filePathRelativeToDataPath, ImportAssetOptions.ForceUpdate);
        Debug.Log("[LOD] Importer set to GltfImporter and reimported.");
    }

    private void ExtractTextures(LODPathHandler pathHandler)
    {
        string texturesFolder = Path.Combine(pathHandler.fileDirectory, "Textures");
        Directory.CreateDirectory(texturesFolder);
        string texturesFolderRelative = PathUtils.GetRelativePathTo(Application.dataPath, texturesFolder);

        // Build a set of texture names used by transparent materials
        var transparentTextureNames = new HashSet<string>();
        var allAssets = AssetDatabase.LoadAllAssetsAtPath(pathHandler.filePathRelativeToDataPath);
        foreach (var asset in allAssets)
        {
            if (asset is Material mat && mat.name.Contains("-transparent", StringComparison.OrdinalIgnoreCase))
            {
                var shader = mat.shader;
                for (int i = 0; i < shader.GetPropertyCount(); i++)
                {
                    if (shader.GetPropertyType(i) != UnityEngine.Rendering.ShaderPropertyType.Texture)
                        continue;
                    var tex = mat.GetTexture(shader.GetPropertyName(i)) as Texture2D;
                    if (tex != null && !string.IsNullOrEmpty(tex.name))
                        transparentTextureNames.Add(tex.name);
                }
                Debug.Log($"[LOD] Transparent material found: {mat.name}");
            }
        }

        int texIdx = 0;
        foreach (var asset in allAssets)
        {
            if (asset is Texture2D tex)
            {
                string texName = string.IsNullOrEmpty(tex.name) ? $"texture_{texIdx}" : tex.name;
                bool needsAlpha = transparentTextureNames.Contains(texName);

                // Blit to a readable RenderTexture to get pixel data
                var rt = RenderTexture.GetTemporary(tex.width, tex.height, 0, RenderTextureFormat.ARGB32);
                Graphics.Blit(tex, rt);
                var prev = RenderTexture.active;
                RenderTexture.active = rt;

                var readable = new Texture2D(tex.width, tex.height, TextureFormat.RGBA32, false);
                readable.ReadPixels(new Rect(0, 0, tex.width, tex.height), 0, 0);
                readable.Apply();

                RenderTexture.active = prev;
                RenderTexture.ReleaseTemporary(rt);

                string ext = needsAlpha ? "png" : "jpg";
                byte[] data = needsAlpha ? readable.EncodeToPNG() : readable.EncodeToJPG(85);
                Object.DestroyImmediate(readable);

                string filePath = Path.Combine(texturesFolder, $"{texName}.{ext}");
                File.WriteAllBytes(filePath, data);
                Debug.Log($"[LOD] Extracted texture: {texName} -> {ext} ({data.Length / 1024}KB) alpha={needsAlpha}");
                texIdx++;
            }
        }

        if (texIdx > 0)
        {
            AssetDatabase.Refresh();
            Debug.Log($"[LOD] Extracted {texIdx} textures to {texturesFolderRelative}");
        }
        else
        {
            Debug.Log("[LOD] No embedded textures found in GLB");
        }
    }

    private Dictionary<int, Mesh> ExtractMeshes(LODPathHandler pathHandler)
    {
        string meshesFolder = Path.Combine(pathHandler.fileDirectory, "Meshes");
        Directory.CreateDirectory(meshesFolder);
        string meshesFolderRelative = PathUtils.GetRelativePathTo(Application.dataPath, meshesFolder);

        var lookup = new Dictionary<int, Mesh>(); // instanceID -> extracted mesh
        var allAssets = AssetDatabase.LoadAllAssetsAtPath(pathHandler.filePathRelativeToDataPath);
        int meshIdx = 0;

        foreach (var asset in allAssets)
        {
            if (asset is Mesh mesh)
            {
                string meshName = string.IsNullOrEmpty(mesh.name) ? $"mesh_{meshIdx}" : mesh.name;
                string destPath = $"{meshesFolderRelative}/{meshName}_{meshIdx}.asset";

                var clone = Object.Instantiate(mesh);
                clone.name = meshName;
                AssetDatabase.CreateAsset(clone, destPath);

                lookup[mesh.GetInstanceID()] = clone;
                Debug.Log($"[LOD] Extracted mesh: {meshName} ({mesh.vertexCount} verts) -> {destPath}");
                meshIdx++;
            }
        }

        if (meshIdx > 0)
        {
            AssetDatabase.SaveAssets();
            AssetDatabase.Refresh();
            Debug.Log($"[LOD] Extracted {meshIdx} meshes to {meshesFolderRelative}");
        }

        return lookup;
    }

    private void RemapMeshReferences(GameObject root, Dictionary<int, Mesh> meshLookup)
    {
        foreach (var meshFilter in root.GetComponentsInChildren<MeshFilter>())
        {
            if (meshFilter.sharedMesh != null && meshLookup.TryGetValue(meshFilter.sharedMesh.GetInstanceID(), out var extracted))
            {
                meshFilter.sharedMesh = extracted;
            }
        }

        foreach (var skinnedRenderer in root.GetComponentsInChildren<SkinnedMeshRenderer>())
        {
            if (skinnedRenderer.sharedMesh != null && meshLookup.TryGetValue(skinnedRenderer.sharedMesh.GetInstanceID(), out var extracted))
            {
                skinnedRenderer.sharedMesh = extracted;
            }
        }

        Debug.Log($"[LOD] Remapped mesh references ({meshLookup.Count} meshes)");
    }

    /// <summary>
    /// Builds a lookup from texture name to extracted standalone texture asset.
    /// </summary>
    private Dictionary<string, Texture2D> BuildExtractedTextureLookup(LODPathHandler pathHandler)
    {
        string texturesFolderRelative = PathUtils.GetRelativePathTo(Application.dataPath,
            Path.Combine(pathHandler.fileDirectory, "Textures"));

        var lookup = new Dictionary<string, Texture2D>();
        string texturesFolder = Path.Combine(pathHandler.fileDirectory, "Textures");
        if (!Directory.Exists(texturesFolder)) return lookup;

        foreach (string file in Directory.GetFiles(texturesFolder))
        {
            string ext = Path.GetExtension(file).ToLower();
            if (ext != ".png" && ext != ".jpg" && ext != ".jpeg") continue;

            string assetPath = PathUtils.GetRelativePathTo(Application.dataPath, file);
            var tex = AssetDatabase.LoadAssetAtPath<Texture2D>(assetPath);
            if (tex != null)
            {
                lookup[tex.name] = tex;
                Debug.Log($"[LOD]   Extracted texture available: {tex.name} -> {assetPath}");
            }
        }
        return lookup;
    }

    private void BuildPrefab(LODPathHandler pathHandler, Parcel parcel)
    {
        Debug.Log($"[LOD] === BuildPrefab START for {pathHandler.fileNameWithoutExtension} ===");

        ConfigureGltfImporter(pathHandler);

        AssetDatabase.SaveAssets();
        AssetDatabase.Refresh();

        // Extract embedded textures from the GLB as standalone assets
        ExtractTextures(pathHandler);

        Debug.Log($"[LOD] Loading prefab at: {pathHandler.filePathRelativeToDataPath}");
        var prefab = AssetDatabase.LoadAssetAtPath<GameObject>(pathHandler.filePathRelativeToDataPath);
        if (prefab == null)
        {
            Debug.LogError($"[LOD] FAILED: Could not load GLB as GameObject at {pathHandler.filePathRelativeToDataPath}");

            // Try to see what Unity thinks is there
            var anyObj = AssetDatabase.LoadMainAssetAtPath(pathHandler.filePathRelativeToDataPath);
            Debug.Log($"[LOD]   LoadMainAsset result: {(anyObj != null ? $"{anyObj.GetType().Name} '{anyObj.name}'" : "NULL")}");
            return;
        }
        Debug.Log($"[LOD] Prefab loaded: {prefab.name}, childCount={prefab.transform.childCount}");

        var instantiated = GameObject.Instantiate(prefab);
        Debug.Log($"[LOD] Instantiated. Renderers: {instantiated.GetComponentsInChildren<Renderer>().Length}");

        // Extract meshes as standalone assets so the GLB can be removed
        var meshLookup = ExtractMeshes(pathHandler);
        RemapMeshReferences(instantiated, meshLookup);

        var extractedTextures = BuildExtractedTextureLookup(pathHandler);
        EnsureTextureFormat(pathHandler);

        Vector4 scenePlane = Vector4.zero;
        float sceneHeight = 0f;
        if (parcel != null)
        {
            scenePlane = SceneCircumscribedPlanesCalculator.CalculateScenePlane(parcel.GetDecodedParcels());
            sceneHeight = SceneCircumscribedPlanesCalculator.CalculateSceneHeight(parcel.GetDecodedParcels().Count);
            Debug.Log($"[LOD] Parcel clipping: plane={scenePlane}, height={sceneHeight}");
        }

        SetLODShaderMaterial(pathHandler, instantiated, extractedTextures, scenePlane, sceneHeight);

        var lodGroup = instantiated.GetComponent<LODGroup>();
        Debug.Log($"[LOD] LODGroup present: {lodGroup != null}");
        if (lodGroup != null)
            Object.DestroyImmediate(lodGroup);

        if (parcel != null)
        {
            Vector2Int baseParcel = parcel.GetDecodedBaseParcel();
            instantiated.transform.position = new Vector3(baseParcel.x * 16f, 0f, baseParcel.y * 16f);
            Debug.Log($"[LOD] Prefab position: parcel {baseParcel} -> {instantiated.transform.position}");
        }

        string prefabPath = $"{pathHandler.fileDirectoryRelativeToDataPath}/{pathHandler.fileNameWithoutExtension}.prefab";
        Debug.Log($"[LOD] Saving prefab to: {prefabPath}");
        PrefabUtility.SaveAsPrefabAsset(instantiated, prefabPath);
        Object.DestroyImmediate(instantiated);

        // Remove GLB so it's not included in the asset bundle
        Debug.Log($"[LOD] Removing GLB: {pathHandler.filePathRelativeToDataPath}");
        AssetDatabase.DeleteAsset(pathHandler.filePathRelativeToDataPath);
        AssetDatabase.Refresh();

        Debug.Log($"[LOD] Setting AB name on folder: {pathHandler.fileDirectoryRelativeToDataPath} -> {pathHandler.assetBundleFileName}");
        var prefabImporter = AssetImporter.GetAtPath(pathHandler.fileDirectoryRelativeToDataPath);
        if (prefabImporter == null)
        {
            Debug.LogError($"[LOD] FAILED: No importer at {pathHandler.fileDirectoryRelativeToDataPath}");
            return;
        }
        Debug.Log($"[LOD]   Folder importer type: {prefabImporter.GetType().Name}");
        prefabImporter.SetAssetBundleNameAndVariant(pathHandler.assetBundleFileName, "");
        Debug.Log($"[LOD]   AB name set: {prefabImporter.assetBundleName}");
        Debug.Log($"[LOD] === BuildPrefab DONE ===");
    }

    private void EnsureTextureFormat(LODPathHandler pathHandler)
    {
        string[] texturePaths = Directory.GetFiles(pathHandler.fileDirectory, "*.*", SearchOption.AllDirectories);
        int textureCount = 0;
        foreach (string texturePath in texturePaths)
        {
            string ext = Path.GetExtension(texturePath).ToLower();
            if (ext != ".png" && ext != ".jpg" && ext != ".jpeg") continue;

            textureCount++;
            string assetPath = PathUtils.GetRelativePathTo(Application.dataPath, texturePath);
            Debug.Log($"[LOD] EnsureTextureFormat: {assetPath}");
            var importer = AssetImporter.GetAtPath(assetPath) as TextureImporter;
            if (importer != null)
            {
                importer.textureType = TextureImporterType.Default;
                importer.isReadable = true;
                importer.SetPlatformTextureSettings(new TextureImporterPlatformSettings
                {
                    overridden = true,
                    maxTextureSize = 512,
                    name = "Standalone",
                    format = TextureImporterFormat.BC7,
                    textureCompression = TextureImporterCompression.Compressed
                });
                AssetDatabase.ImportAsset(assetPath, ImportAssetOptions.ForceUpdate);
            }
            else
            {
                Debug.LogWarning($"[LOD]   No TextureImporter for {assetPath}");
            }
        }
        Debug.Log($"[LOD] EnsureTextureFormat: processed {textureCount} textures");
    }

    private void SetLODShaderMaterial(LODPathHandler pathHandler, GameObject root, Dictionary<string, Texture2D> extractedTextures, Vector4 scenePlane, float sceneHeight)
    {
        var renderers = root.GetComponentsInChildren<Renderer>();
        Debug.Log($"[LOD] SetLODShaderMaterial: {renderers.Length} renderers, {extractedTextures.Count} extracted textures");
        var materialCache = new System.Collections.Generic.Dictionary<string, Material>();

        foreach (var renderer in renderers)
        {
            var newMaterials = new System.Collections.Generic.List<Material>();

            for (int i = 0; i < renderer.sharedMaterials.Length; i++)
            {
                var srcMat = renderer.sharedMaterials[i];
                if (srcMat == null)
                {
                    Debug.LogWarning($"[LOD]   Null material on {renderer.name}[{i}]");
                    continue;
                }

                var baseMap = CollectBaseMap(srcMat, extractedTextures);

                // Grab tiling/offset before shader swap
                Vector2 tiling = srcMat.HasProperty("baseColorTexture_ST")
                    ? srcMat.GetTextureScale("baseColorTexture")
                    : Vector2.one;
                Vector2 offset = srcMat.HasProperty("baseColorTexture_ST")
                    ? srcMat.GetTextureOffset("baseColorTexture")
                    : Vector2.zero;

                Debug.Log($"[LOD]     Tiling={tiling}, Offset={offset} from {srcMat.name}");

                var mat = new Material(srcMat);
                mat.shader = lodShader;

                mat.SetVector(PLANE_CLIPPING_ID, scenePlane);
                mat.SetVector(VERTICAL_CLIPPING_ID, new Vector4(0f, sceneHeight, 0f, 0f));

                if (baseMap != null)
                {
                    mat.SetTexture("_BaseMap", baseMap);
                    mat.SetTextureScale("_BaseMap", tiling);
                    mat.SetTextureOffset("_BaseMap", offset);
                }

                if (mat.name.Contains("-transparent", StringComparison.OrdinalIgnoreCase))
                {
                    Debug.Log($"[LOD]   Applying transparency to {mat.name}");
                    mat.EnableKeyword("_ALPHAPREMULTIPLY_ON");
                    mat.EnableKeyword("_SURFACE_TYPE_TRANSPARENT");
                    mat.SetFloat("_Surface", 1);
                    mat.SetFloat("_BlendMode", 0);
                    mat.SetFloat("_AlphaCutoffEnable", 0);
                    mat.SetFloat("_SrcBlend", 1f);
                    mat.SetFloat("_DstBlend", 10f);
                    mat.SetFloat("_AlphaSrcBlend", 1f);
                    mat.SetFloat("_AlphaDstBlend", 10f);
                    mat.SetFloat("_ZTestDepthEqualForOpaque", 4f);
                    mat.renderQueue = (int)UnityEngine.Rendering.RenderQueue.Transparent;
                    mat.color = new Color(mat.color.r, mat.color.g, mat.color.b, 0.8f);
                }

                string matName = $"{mat.name.Replace("(Instance)", pathHandler.fileNameWithoutExtension)}.mat";
                if (!materialCache.ContainsKey(matName))
                {
                    string matPath = Path.Combine(pathHandler.materialsPathRelativeToDataPath, matName);
                    Debug.Log($"[LOD]   Creating material: {matPath}");
                    AssetDatabase.CreateAsset(mat, matPath);
                    AssetDatabase.Refresh();
                    materialCache.Add(matName, AssetDatabase.LoadAssetAtPath<Material>(matPath));
                }
                newMaterials.Add(materialCache[matName]);
            }
            renderer.sharedMaterials = newMaterials.ToArray();
        }
        Debug.Log($"[LOD] SetLODShaderMaterial done. {materialCache.Count} materials created.");
    }

    private Texture2D CollectBaseMap(Material srcMat, Dictionary<string, Texture2D> extractedTextures)
    {
        // Try glTFast name first, then URP name
        var tex = srcMat.GetTexture("baseColorTexture") as Texture2D
               ?? srcMat.GetTexture("_BaseMap") as Texture2D;

        if (tex == null) return null;

        if (extractedTextures.TryGetValue(tex.name, out var extracted))
        {
            Debug.Log($"[LOD]     Collected baseMap: '{tex.name}' -> extracted");
            return extracted;
        }

        return tex;
    }

    public void BuildAssetBundles(BuildTarget target)
    {
        Debug.Log($"[LOD] === BuildAssetBundles START (target={target}, output={lodPathHandler.outputPath}) ===");
        AssetDatabase.Refresh(ImportAssetOptions.ForceSynchronousImport | ImportAssetOptions.ForceUpdate);
        AssetDatabase.SaveAssets();

        IBuildPipeline buildPipeline = new ScriptableBuildPipeline();

        Debug.Log("[LOD] First pass build...");
        var manifest = buildPipeline.BuildAssetBundles(lodPathHandler.outputPath,
            BuildAssetBundleOptions.ChunkBasedCompression | BuildAssetBundleOptions.ForceRebuildAssetBundle |
            BuildAssetBundleOptions.AssetBundleStripUnityVersion,
            target);

        if (manifest == null)
        {
            Debug.LogError("[LOD] FAILED: First pass build returned null manifest!");
            Utils.Exit(1);
            return;
        }

        string[] lodAssetBundles = manifest.GetAllAssetBundles();
        Debug.Log($"[LOD] First pass produced {lodAssetBundles.Length} bundles: [{string.Join(", ", lodAssetBundles)}]");

        foreach (string assetBundle in lodAssetBundles)
        {
            if (assetBundle.Contains("_ignore"))
            {
                Debug.Log($"[LOD]   Skipping ignored bundle: {assetBundle}");
                continue;
            }

            string lodName = PlatformUtils.RemovePlatform(assetBundle);
            Debug.Log($"[LOD]   Generating metadata for: {assetBundle} (lodName={lodName})");
            string[] deps = manifest.GetAllDependencies(assetBundle);
            Debug.Log($"[LOD]     Dependencies: [{string.Join(", ", deps)}]");
            AssetBundleMetadataBuilder.GenerateLODMetadata(lodPathHandler.tempPath,
                deps, $"{lodName}.prefab", lodName);
        }

        AssetDatabase.Refresh(ImportAssetOptions.ForceSynchronousImport | ImportAssetOptions.ForceUpdate);
        AssetDatabase.SaveAssets();

        Debug.Log("[LOD] Second pass build...");
        buildPipeline.BuildAssetBundles(lodPathHandler.outputPath,
            BuildAssetBundleOptions.ChunkBasedCompression | BuildAssetBundleOptions.ForceRebuildAssetBundle |
            BuildAssetBundleOptions.AssetBundleStripUnityVersion,
            target);
        Debug.Log("[LOD] === BuildAssetBundles DONE ===");
    }
}
