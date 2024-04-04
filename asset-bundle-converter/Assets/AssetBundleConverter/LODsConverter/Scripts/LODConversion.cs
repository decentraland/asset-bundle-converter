using System;
using System.Collections;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Threading.Tasks;
using AssetBundleConverter.LODsConverter.Utils;
using AssetBundleConverter.Wrappers.Interfaces;
using DCL;
using DCL.ABConverter;
using UnityEditor;
using UnityEngine;
using UnityEngine.Rendering;
using Object = UnityEngine.Object;
using SystemWrappers = AssetBundleConverter.Wrappers.Implementations.Default.SystemWrappers;

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
        //TODO (Juani) Temporal hack. Clean with the regular asset bundle process
        ClearDownloadedFolder();
        IAssetDatabase assetDatabase = new UnityEditorWrappers.AssetDatabase();
        string[] downloadedFilePaths;
        try
        {
            downloadedFilePaths = await DownloadFiles();
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
            var dictionaryStringForMetadata = new Dictionary<string, string>();
            foreach (string downloadedFilePath in downloadedFilePaths)
            {
                lodPathHandler.SetCurrentFile(downloadedFilePath);
                dictionaryStringForMetadata.Add(lodPathHandler.fileNameWithoutExtension, lodPathHandler.fileNameWithoutExtension);
                lodPathHandler.MoveFileToMatchingFolder();
                BuildPrefab(lodPathHandler);
            }
            AssetDatabase.SaveAssets();
            AssetDatabase.Refresh();
            assetDatabase.AssignAssetBundle(usedLOD0Shader, false);
            assetDatabase.AssignAssetBundle(usedLODShader, false);
            //BuildAssetBundles(EditorUserBuildSettings.activeBuildTarget, dictionaryStringForMetadata);
        }
        catch (Exception e)
        {
            Directory.Delete(lodPathHandler.tempPath, true);
            Utils.Exit(1);
            return;
        }

        lodPathHandler.RelocateOutputFolder();
        //Directory.Delete(lodPathHandler.tempPath, true);
        Debug.Log("Conversion done");
        Utils.Exit();
    }

    private void ClearDownloadedFolder()
    {
        if (Directory.Exists(Config.GetDownloadPath()))
            Directory.Delete(Config.GetDownloadPath(), true);
    }

    private async Task<string[]> DownloadFiles()
    {
        var urlFileDownloader = new URLFileDownloader(urlsToConvert, lodPathHandler.tempPath);
        Debug.Log("ALL files downloaded succesfully!");
        return await urlFileDownloader.Download();
    }

    private void BuildPrefab(LODPathHandler lodPathHandler)
    {
        var importer = AssetImporter.GetAtPath(lodPathHandler.filePathRelativeToDataPath) as ModelImporter;
        if (importer == null) return;

        importer.ExtractTextures(lodPathHandler.fileDirectoryRelativeToDataPath);
        AssetDatabase.WriteImportSettingsIfDirty(lodPathHandler.filePathRelativeToDataPath);
        AssetDatabase.ImportAsset(lodPathHandler.filePathRelativeToDataPath, ImportAssetOptions.ForceUpdate);

        var asset = AssetDatabase.LoadAssetAtPath<GameObject>(lodPathHandler.filePathRelativeToDataPath);

        if (lodPathHandler.filePath.Contains("_0"))
        {
            SetDCLShaderMaterial(lodPathHandler, asset, false, usedLOD0Shader);
        }
        else
        {
            EnsureTextureFormat();
            SetDCLShaderMaterial(lodPathHandler, asset, true, usedLODShader);
        }

        importer.SearchAndRemapMaterials(ModelImporterMaterialName.BasedOnMaterialName, ModelImporterMaterialSearch.Local);
        AssetDatabase.WriteImportSettingsIfDirty(lodPathHandler.filePathRelativeToDataPath);
        AssetDatabase.ImportAsset(lodPathHandler.filePath, ImportAssetOptions.ForceUpdate);

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

    private void SetDCLShaderMaterial(LODPathHandler lodPathHandler, GameObject transform, bool setDefaultTransparency, Shader shader)
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
                
                if (duplicatedMaterial.name.Contains("FORCED_TRANSPARENT"))
                    ApplyTransparency(duplicatedMaterial, setDefaultTransparency);

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

    public void BuildAssetBundles(BuildTarget target, Dictionary<string, string> dictionaryForMetadataBuilder)
    {
        AssetDatabase.Refresh(ImportAssetOptions.ForceSynchronousImport | ImportAssetOptions.ForceUpdate);
        AssetDatabase.SaveAssets();

        IBuildPipeline buildPipeline = new ScriptableBuildPipeline();
        
        // 1. Convert flagged folders to asset bundles only to automatically get dependencies for the metadata
        var manifest = buildPipeline.BuildAssetBundles(lodPathHandler.outputPath,
            BuildAssetBundleOptions.UncompressedAssetBundle | BuildAssetBundleOptions.ForceRebuildAssetBundle | BuildAssetBundleOptions.AssetBundleStripUnityVersion,
            target);

        if (manifest == null)
        {
            string message = "Error generating asset bundle!";
            Utils.Exit(1);
        }

        // 2. Create metadata (dependencies, version, timestamp) and store in the target folders to be converted again later with the metadata inside
        AssetBundleMetadataBuilder.Generate(new SystemWrappers.File(), lodPathHandler.tempPath, dictionaryForMetadataBuilder, manifest, VERSION);

        AssetDatabase.Refresh(ImportAssetOptions.ForceSynchronousImport | ImportAssetOptions.ForceUpdate);
        AssetDatabase.SaveAssets();

        // 3. Convert flagged folders to asset bundles again but this time they have the metadata file inside
        buildPipeline.BuildAssetBundles(lodPathHandler.outputPath,
            BuildAssetBundleOptions.UncompressedAssetBundle | BuildAssetBundleOptions.ForceRebuildAssetBundle | BuildAssetBundleOptions.AssetBundleStripUnityVersion,
            target);
    }
}