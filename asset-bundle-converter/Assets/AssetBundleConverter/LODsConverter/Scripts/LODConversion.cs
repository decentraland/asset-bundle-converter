using System;
using System.Collections;
using System.Collections.Generic;
using System.IO;
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
    private readonly string outputPath;
    private readonly string tempPath;

    private readonly string[] urlsToConvert;
    private string[] downloadedFiles;

    public IBuildPipeline buildPipeline;

    public LODConversion(string customOutputPath, string[] urlsToConvert)
    {
        this.urlsToConvert = urlsToConvert;
        tempPath = LODConstants.DEFAULT_TEMP_PATH;
        outputPath = !string.IsNullOrEmpty(customOutputPath) ? customOutputPath : LODConstants.DEFAULT_OUTPUT_PATH;
    }

    public async void ConvertLODs()
    {
        Directory.CreateDirectory(outputPath);
        Directory.CreateDirectory(tempPath);
        await DownloadFiles();
        AssetDatabase.SaveAssets();
        try
        {
            foreach (string downloadedFile in downloadedFiles)
            {
                string fileNameWithoutExtension = Path.GetFileNameWithoutExtension(downloadedFile).ToLower();
                string assetBundlePath = Path.Combine(outputPath, fileNameWithoutExtension);
                if (File.Exists(assetBundlePath))
                    continue;

                string newPath = LODUtils.MoveFileToMatchingFolder(downloadedFile);
                BuildPrefab(PathUtils.GetRelativePathTo(Application.dataPath, newPath));

                buildPipeline = new ScriptableBuildPipeline();
                BuildAssetBundles(EditorUserBuildSettings.activeBuildTarget, Path.GetFileNameWithoutExtension(downloadedFile).ToLower(), out var manifest);

                //Directory.Delete(tempPath, true);
                Debug.Log("Conversion done");
                Utils.Exit();
            }
        }
        catch (Exception e)
        {
            Utils.Exit(1);
        }
    }

    private async Task DownloadFiles()
    {
        Debug.Log("Starting file download");
        var urlFileDownloader = new URLFileDownloader(urlsToConvert, tempPath);
        downloadedFiles = await urlFileDownloader.Download();
        Debug.Log("Finished file download");
    }

    private void BuildPrefab(string fileToProcess)
    {
        var asset = AssetDatabase.LoadAssetAtPath<Object>(fileToProcess);
        if (asset == null) return;

        string fileNameWithoutExtension = Path.GetFileNameWithoutExtension(fileToProcess).ToLower();
        string filePath = Path.GetDirectoryName(fileToProcess);
        string filePathRelativeToDataPath = PathUtils.GetRelativePathTo(Application.dataPath, filePath);

        // Extracting textures and materials
        var importer = AssetImporter.GetAtPath(fileToProcess) as ModelImporter;

        if (importer != null)
        {
            importer.ExtractTextures(Path.GetDirectoryName(fileToProcess));
            importer.materialImportMode = ModelImporterMaterialImportMode.ImportStandard;
            AssetDatabase.WriteImportSettingsIfDirty(fileToProcess);
            AssetDatabase.ImportAsset(fileToProcess, ImportAssetOptions.ForceUpdate);

            var instantiated = Object.Instantiate(AssetDatabase.LoadAssetAtPath<GameObject>(fileToProcess));
            instantiated.name = fileNameWithoutExtension;

            if (fileToProcess.Contains("_0"))
            {
                SetDCLShaderMaterial(fileToProcess, instantiated, filePathRelativeToDataPath, false);
                GenerateColliders(fileToProcess, instantiated);
            }
            else
                SetDCLShaderMaterial(fileToProcess, instantiated,  filePathRelativeToDataPath, true);


            string prefabPath = filePath + "/" + instantiated + ".prefab";
            PrefabUtility.SaveAsPrefabAsset(instantiated, prefabPath);
            Object.DestroyImmediate(instantiated);

            var prefabImporter = AssetImporter.GetAtPath(filePath);
            prefabImporter.SetAssetBundleNameAndVariant(fileNameWithoutExtension, "");
            AssetDatabase.Refresh();
        }
    }

    private void GenerateColliders(string path, GameObject instantiated)
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

    private void SetDCLShaderMaterial(string path, GameObject transform, string tempPath, bool setDefaultTransparency)
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

                string materialName = $"{duplicatedMaterial.name.Replace("(Instance)", Path.GetFileNameWithoutExtension(path))}.mat";
                if (!materialsDictionary.ContainsKey(materialName))
                {
                    string materialPath = Path.Combine(tempPath, materialName);
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

    public bool BuildAssetBundles(BuildTarget target, string fileName, out IAssetBundleManifest manifest)
    {
        AssetDatabase.Refresh(ImportAssetOptions.ForceSynchronousImport | ImportAssetOptions.ForceUpdate);
        AssetDatabase.SaveAssets();

        // 1. Convert flagged folders to asset bundles only to automatically get dependencies for the metadata
        manifest = buildPipeline.BuildAssetBundles(outputPath,
            BuildAssetBundleOptions.UncompressedAssetBundle | BuildAssetBundleOptions.ForceRebuildAssetBundle | BuildAssetBundleOptions.AssetBundleStripUnityVersion,
            target);

        if (manifest == null)
        {
            string message = "Error generating asset bundle!";
            Utils.Exit(1);
            return false;
        }

        // 2. Create metadata (dependencies, version, timestamp) and store in the target folders to be converted again later with the metadata inside
        AssetBundleMetadataBuilder.Generate(new SystemWrappers.File(),
            tempPath, new Dictionary<string, string>
            {
                {
                    fileName, fileName
                }
            }, manifest);

        AssetDatabase.Refresh(ImportAssetOptions.ForceSynchronousImport | ImportAssetOptions.ForceUpdate);
        AssetDatabase.SaveAssets();

        // 3. Convert flagged folders to asset bundles again but this time they have the metadata file inside
        manifest = buildPipeline.BuildAssetBundles(outputPath,
            BuildAssetBundleOptions.UncompressedAssetBundle | BuildAssetBundleOptions.ForceRebuildAssetBundle | BuildAssetBundleOptions.AssetBundleStripUnityVersion,
            target);

        return true;
    }
}