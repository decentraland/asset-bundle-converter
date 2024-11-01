using System;
using System.Collections.Generic;
using System.IO;
using System.Threading.Tasks;
using AssetBundleConverter.LODsConverter.Utils;
using DCL;
using DCL.ABConverter;
using UnityEditor;
using UnityEngine;
using UnityEngine.Rendering;
using Object = UnityEngine.Object;

public class LODConversion
{
    private readonly LODPathHandler lodPathHandler;
    private readonly string[] urlsToConvert;
    private readonly Shader usedLODShader;
    private readonly Shader usedLOD0Shader;

    //TODO: CLEAN THIS UP HERE AND IN THE ASSET BUNDLE BUILDER. THIS IS NOT USED IN ALPHA
    private const string VERSION = "7.0";

    public LODConversion(string customOutputPath, string[] urlsToConvert)
    {
        this.urlsToConvert = urlsToConvert;
        lodPathHandler = new LODPathHandler(customOutputPath);
        usedLOD0Shader = Shader.Find("DCL/Scene");
        usedLODShader = Shader.Find("DCL/Scene_TexArray");
    }

    public async Task ConvertLODs()
    {
        PlatformUtils.currentTarget = EditorUserBuildSettings.activeBuildTarget;

        IAssetDatabase assetDatabase = new UnityEditorWrappers.AssetDatabase();
        IWebRequestManager webRequestManager = new WebRequestManager(); 
        string[] downloadedFilePaths;
        try
        {
            downloadedFilePaths = await webRequestManager.DownloadAndSaveFiles(urlsToConvert, lodPathHandler.tempPath);
        }
        catch (Exception e)
        {
            Debug.Log("DOWNLOAD FAILED");
            Utils.Exit(1);
            return;
        }
        AssetDatabase.SaveAssets();
        AssetDatabase.Refresh();
        try
        {
            foreach (string downloadedFilePath in downloadedFilePaths)
            {
                lodPathHandler.SetCurrentFile(downloadedFilePath);
                var parcel = await webRequestManager.GetParcel(lodPathHandler.fileName);
                lodPathHandler.MoveFileToMatchingFolder();
                BuildPrefab(lodPathHandler, parcel);
            }
            AssetDatabase.SaveAssets();
            AssetDatabase.Refresh();
            assetDatabase.AssignAssetBundle(usedLOD0Shader, false);
            assetDatabase.AssignAssetBundle(usedLODShader, false);
            BuildAssetBundles(EditorUserBuildSettings.activeBuildTarget);
        }
        catch (Exception e)
        {
            Debug.LogError($"Unexpected exit with error {e.Message}");
            Directory.Delete(lodPathHandler.tempPath, true);
            Utils.Exit(1);
            return;
        }

        lodPathHandler.RelocateOutputFolder();
        Directory.Delete(lodPathHandler.tempPath, true);
        foreach (string downloadedFilePath in downloadedFilePaths)
        {
            Debug.Log($"LOD conversion done for {Path.GetFileName(downloadedFilePath)}");
        }
        Utils.Exit();
    }

    private void BuildPrefab(LODPathHandler lodPathHandler, Parcel parcel)
    {
        var importer = AssetImporter.GetAtPath(lodPathHandler.filePathRelativeToDataPath) as ModelImporter;
        if (importer == null) return;

        importer.ExtractTextures(lodPathHandler.fileDirectoryRelativeToDataPath);
        AssetDatabase.WriteImportSettingsIfDirty(lodPathHandler.filePathRelativeToDataPath);
        AssetDatabase.ImportAsset(lodPathHandler.filePathRelativeToDataPath, ImportAssetOptions.ForceUpdate);

        var instantiatedLOD = GameObject.Instantiate(AssetDatabase.LoadAssetAtPath<GameObject>(lodPathHandler.filePathRelativeToDataPath));
        
        Vector4 scenePlane 
            = SceneCircumscribedPlanesCalculator.CalculateScenePlane(parcel.GetDecodedParcels());
        
        if (lodPathHandler.filePath.Contains("_0"))
        {
            SetDCLShaderMaterial(lodPathHandler, instantiatedLOD, false, usedLOD0Shader, scenePlane);
            ColliderGenerator.GenerateColliders(instantiatedLOD);
            SkinnedMeshRendererValidator.ValidateSkinnedMeshRenderer(instantiatedLOD);
        }
        else
        {
            EnsureTextureFormat();
            SetDCLShaderMaterial(lodPathHandler, instantiatedLOD, true, usedLODShader, scenePlane);
        }

        importer.SearchAndRemapMaterials(ModelImporterMaterialName.BasedOnMaterialName, ModelImporterMaterialSearch.Local);
        AssetDatabase.WriteImportSettingsIfDirty(lodPathHandler.filePathRelativeToDataPath);
        AssetDatabase.ImportAsset(lodPathHandler.filePath, ImportAssetOptions.ForceUpdate);
        
        SceneCircumscribedPlanesCalculator.DisableObjectsOutsideBounds(parcel, instantiatedLOD);

        PrefabUtility.SaveAsPrefabAsset(instantiatedLOD,  $"{lodPathHandler.fileDirectoryRelativeToDataPath}/{lodPathHandler.fileNameWithoutExtension}.prefab");
        Object.DestroyImmediate(instantiatedLOD);
        AssetDatabase.Refresh();

        var prefabImporter = AssetImporter.GetAtPath(lodPathHandler.fileDirectoryRelativeToDataPath);
        prefabImporter.SetAssetBundleNameAndVariant(lodPathHandler.assetBundleFileName, "");
    }

    private void EnsureTextureFormat()
    {
        string[] texturePaths = Directory.GetFiles(lodPathHandler.fileDirectory, "*.png", SearchOption.AllDirectories);
        foreach (string texturePath in texturePaths)
        {
            string assetPath = PathUtils.GetRelativePathTo(Application.dataPath, texturePath);
            var importer = AssetImporter.GetAtPath(assetPath) as TextureImporter;
            var texture = AssetDatabase.LoadAssetAtPath<Texture2D>(assetPath);
            if (importer != null)
            {
                importer.textureType = TextureImporterType.Default;
                importer.isReadable = true;
                importer.SetPlatformTextureSettings(new TextureImporterPlatformSettings
                {
                    overridden = true, maxTextureSize = texture.width, name = "Standalone", format = TextureImporterFormat.BC7,
                    textureCompression = TextureImporterCompression.Compressed
                });
                AssetDatabase.ImportAsset(assetPath, ImportAssetOptions.ForceUpdate);
            }
        }
    }

    private void SetNormalTextureFormat(string textureName)
    {
        string assetPath = PathUtils.GetRelativePathTo(Application.dataPath, $"{lodPathHandler.fileDirectory}/{textureName}.png");
        var importer = AssetImporter.GetAtPath(assetPath) as TextureImporter;
        if (importer != null)
        {
            importer.textureType = TextureImporterType.NormalMap;
            AssetDatabase.ImportAsset(assetPath, ImportAssetOptions.ForceUpdate);
        }
    }

    private void SetDCLShaderMaterial(LODPathHandler lodPathHandler, GameObject transform, bool setDefaultTransparency, Shader shader, Vector4 scenePlane)
    {
        var childrenRenderers = transform.GetComponentsInChildren<Renderer>();
        var materialsDictionary = new Dictionary<string, Material>();
        foreach (var componentsInChild in childrenRenderers)
        {
            var savedMaterials = new List<Material>();
            for (int i = 0; i < componentsInChild.sharedMaterials.Length; i++)
            {
                var material = componentsInChild.sharedMaterials[i];
                var duplicatedMaterial = new Material(material);
                duplicatedMaterial.shader = shader;
                duplicatedMaterial.SetVector(Shader.PropertyToID("_PlaneClipping"), scenePlane);
                
                if (duplicatedMaterial.name.Contains("FORCED_TRANSPARENT"))
                    ApplyTransparency(duplicatedMaterial, setDefaultTransparency);

                
                if (duplicatedMaterial.GetTexture("_BumpMap") != null)
                    SetNormalTextureFormat(duplicatedMaterial.GetTexture("_BumpMap").name);

                string materialName = $"{duplicatedMaterial.name.Replace("(Instance)", lodPathHandler.fileNameWithoutExtension)}.mat";
                if (!materialsDictionary.ContainsKey(materialName))
                {
                    string materialPath = Path.Combine(lodPathHandler.materialsPathRelativeToDataPath, materialName);
                    AssetDatabase.CreateAsset(duplicatedMaterial, materialPath);
                    AssetDatabase.Refresh();
                    materialsDictionary.Add(materialName, AssetDatabase.LoadAssetAtPath<Material>(materialPath));
                }
                savedMaterials.Add(materialsDictionary[materialName]);
            }
            componentsInChild.sharedMaterials = savedMaterials.ToArray();
        }
    }

    private void ApplyTransparency(Material duplicatedMaterial, bool setDefaultTransparency)
    {
        duplicatedMaterial.EnableKeyword("_ALPHAPREMULTIPLY_ON");
        duplicatedMaterial.EnableKeyword("_SURFACE_TYPE_TRANSPARENT");

        duplicatedMaterial.SetFloat("_Surface",  1);
        duplicatedMaterial.SetFloat("_BlendMode", 0);
        duplicatedMaterial.SetFloat("_AlphaCutoffEnable", 0);
        duplicatedMaterial.SetFloat("_SrcBlend", 1f);
        duplicatedMaterial.SetFloat("_DstBlend", 10f);
        duplicatedMaterial.SetFloat("_AlphaSrcBlend", 1f);
        duplicatedMaterial.SetFloat("_AlphaDstBlend", 10f);
        duplicatedMaterial.SetFloat("_ZTestDepthEqualForOpaque", 4f);
        duplicatedMaterial.renderQueue = (int)RenderQueue.Transparent;

        duplicatedMaterial.color = new Color(duplicatedMaterial.color.r, duplicatedMaterial.color.g, duplicatedMaterial.color.b, setDefaultTransparency ? 0.8f : duplicatedMaterial.color.a);
    }

    public void BuildAssetBundles(BuildTarget target)
    {
        AssetDatabase.Refresh(ImportAssetOptions.ForceSynchronousImport | ImportAssetOptions.ForceUpdate);
        AssetDatabase.SaveAssets();

        IBuildPipeline buildPipeline = new ScriptableBuildPipeline();
        
        // 1. Convert flagged folders to asset bundles only to automatically get dependencies for the metadata
        var manifest = buildPipeline.BuildAssetBundles(lodPathHandler.outputPath,
            BuildAssetBundleOptions.ChunkBasedCompression | BuildAssetBundleOptions.ForceRebuildAssetBundle |
            BuildAssetBundleOptions.AssetBundleStripUnityVersion,
            target);

        if (manifest == null)
        {
            string message = "Error generating asset bundle!";
            Utils.Exit(1);
        }
        
        string[] lodAssetBundles = manifest.GetAllAssetBundles();
        foreach (string assetBundle in lodAssetBundles)
        {
            if (assetBundle.Contains("_ignore"))
                continue;

            string lodName = PlatformUtils.RemovePlatform(assetBundle);
            // 2. Create metadata (dependencies, version, timestamp) and store in the target folders to be converted again later with the metadata inside
            AssetBundleMetadataBuilder.GenerateLODMetadata(lodPathHandler.tempPath,
                manifest.GetAllDependencies(assetBundle), $"{lodName}.prefab", lodName);
        }
        

        AssetDatabase.Refresh(ImportAssetOptions.ForceSynchronousImport | ImportAssetOptions.ForceUpdate);
        AssetDatabase.SaveAssets();

        // 3. Convert flagged folders to asset bundles again but this time they have the metadata file inside
        buildPipeline.BuildAssetBundles(lodPathHandler.outputPath,
            BuildAssetBundleOptions.ChunkBasedCompression | BuildAssetBundleOptions.ForceRebuildAssetBundle |
            BuildAssetBundleOptions.AssetBundleStripUnityVersion,
            target);
    }
    
    
}