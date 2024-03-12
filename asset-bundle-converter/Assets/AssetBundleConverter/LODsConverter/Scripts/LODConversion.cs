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

    //TODO: CLEAN THIS UP HERE AND IN THE ASSET BUNDLE BUILDER. THIS IS NOT USED IN ALPHA
    private const string VERSION = "7.0";

    public LODConversion(string customOutputPath, string[] urlsToConvert)
    {
        this.urlsToConvert = urlsToConvert;
        lodPathHandler = new LODPathHandler(customOutputPath);
    }

    public async void ConvertLODs()
    {
        PlatformUtils.currentTarget = EditorUserBuildSettings.activeBuildTarget;
        IAssetDatabase assetDatabase = new UnityEditorWrappers.AssetDatabase();

        string[] downloadedFilePaths = await DownloadFiles();
        AssetDatabase.SaveAssets();
        AssetDatabase.Refresh();
        try
        {
            var dictionaryStringForMetadata = new Dictionary<string, string>();
            foreach (string downloadedFilePath in downloadedFilePaths)
            {
                lodPathHandler.SetCurrentFile(downloadedFilePath);
                if (File.Exists(lodPathHandler.assetBundlePath))
                    continue;
                dictionaryStringForMetadata.Add(lodPathHandler.fileNameWithoutExtension, lodPathHandler.fileNameWithoutExtension);
                lodPathHandler.MoveFileToMatchingFolder();
                BuildPrefab(lodPathHandler);
            }

            AssetDatabase.SaveAssets();
            AssetDatabase.Refresh();
            assetDatabase.AssignAssetBundle(Shader.Find("DCL/Scene"), false);
            BuildAssetBundles(EditorUserBuildSettings.activeBuildTarget, dictionaryStringForMetadata);
        }
        catch (Exception e)
        {
            Directory.Delete(lodPathHandler.tempPath, true);
            Utils.Exit(1);
        }

        //Directory.Delete(tempPath, true);
        Debug.Log("Conversion done");
        Utils.Exit();
    }

    private async Task<string[]> DownloadFiles()
    {
        Debug.Log("Starting file download");
        var urlFileDownloader = new URLFileDownloader(urlsToConvert, lodPathHandler.tempPath);
        Debug.Log("Finished file download");
        return await urlFileDownloader.Download();
    }

    private void BuildPrefab(LODPathHandler lodPathHandler)
    {
        var importer = AssetImporter.GetAtPath(lodPathHandler.filePathRelativeToDataPath) as ModelImporter;
        if (importer == null) return;

        importer.ExtractTextures(lodPathHandler.fileDirectoryRelativeToDataPath);
        AssetDatabase.WriteImportSettingsIfDirty(lodPathHandler.filePathRelativeToDataPath);
        AssetDatabase.ImportAsset(lodPathHandler.filePathRelativeToDataPath, ImportAssetOptions.ForceUpdate);

        var instantiated = Object.Instantiate(AssetDatabase.LoadAssetAtPath<GameObject>(lodPathHandler.filePathRelativeToDataPath));

        if (lodPathHandler.filePath.Contains("_0"))
        {
            SetDCLShaderMaterial(lodPathHandler, instantiated, false);
            GenerateColliders(instantiated);
        }
        else
            SetDCLShaderMaterial(lodPathHandler, instantiated, true);

        importer.SearchAndRemapMaterials(ModelImporterMaterialName.BasedOnMaterialName, ModelImporterMaterialSearch.Local);
        AssetDatabase.WriteImportSettingsIfDirty(lodPathHandler.filePathRelativeToDataPath);
        AssetDatabase.ImportAsset(lodPathHandler.filePath, ImportAssetOptions.ForceUpdate);

        PrefabUtility.SaveAsPrefabAsset(instantiated, lodPathHandler.prefabPathRelativeToDataPath);
        Object.DestroyImmediate(instantiated);

        var prefabImporter = AssetImporter.GetAtPath(lodPathHandler.prefabPathRelativeToDataPath);
        prefabImporter.SetAssetBundleNameAndVariant(lodPathHandler.assetBundleFileName, "");
    }

    private void GenerateColliders(GameObject instantiated)
    {
        var meshFilters = instantiated.GetComponentsInChildren<MeshFilter>();

        foreach (var filter in meshFilters)
        {
            if (filter.name.Contains("_collider", StringComparison.OrdinalIgnoreCase))
                ConfigureColliders(filter.transform, filter);
        }

        var renderers = instantiated.GetComponentsInChildren<Renderer>();

        foreach (var r in renderers)
        {
            if (r.name.Contains("_collider", StringComparison.OrdinalIgnoreCase))
                Object.DestroyImmediate(r);
        }
    }

    private void ConfigureColliders(Transform transform, MeshFilter filter)
    {
        if (filter != null)
        {
            Physics.BakeMesh(filter.sharedMesh.GetInstanceID(), false);
            filter.gameObject.AddComponent<MeshCollider>();
            Object.DestroyImmediate(filter.GetComponent<MeshRenderer>());
        }

        foreach (Transform child in transform)
        {
            var f = child.gameObject.GetComponent<MeshFilter>();
            ConfigureColliders(child, f);
        }
    }

    private void SetDCLShaderMaterial(LODPathHandler lodPathHandler, GameObject transform, bool setDefaultTransparency)
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
                duplicatedMaterial.shader = Shader.Find("DCL/Scene");
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