using System;
using UnityEngine;
using UnityEditor;
using System.IO;
using System.Collections.Generic;
using System.Linq;
using DCL.ABConverter;
using DCL.Shaders;
using UnityEngine.Experimental.Rendering;
using UnityEngine.Rendering;
using Object = UnityEngine.Object;
using Random = UnityEngine.Random;

public class ExportFBXAssetBundles : MonoBehaviour
{
    [MenuItem("Assets/Export FBX To Asset Bundles")]
    private static void ExportAllAssetBundles()
    {
        string inPath = Path.Combine(Application.dataPath, "ExportToAssetBundle");
        string tempPath = Path.Combine(Application.dataPath, "temp");
        string outputPath = Path.Combine(Application.dataPath, "../AssetBundles/");
        Directory.CreateDirectory(outputPath);

        string[] fileEntries = Directory.GetFiles(inPath, "*.fbx", SearchOption.AllDirectories);
        foreach (string fileName in fileEntries)
        {
            string fileNameWithoutExtension = Path.GetFileNameWithoutExtension(fileName);
            string assetBundlePath = Path.Combine(outputPath, fileNameWithoutExtension.ToLower());
            if (File.Exists(assetBundlePath))
                continue;

            string newPath = MoveFileToMatchingFolder(fileName);

            Directory.CreateDirectory(tempPath);
            //Get the relative path from the Assets folder
            ProcessFBX(PathUtils.GetRelativePathTo(Application.dataPath, newPath), tempPath);
            GC.Collect();
        }

        // Save assets and refresh the AssetDatabase
        AssetDatabase.SaveAssets();
        AssetDatabase.Refresh();

        BuildPipeline.BuildAssetBundles(outputPath,  BuildAssetBundleOptions.None, EditorUserBuildSettings.activeBuildTarget);
        Directory.Delete(tempPath, true);
        Debug.Log("Conversion done");
    }

    private static string MoveFileToMatchingFolder(string filePath)
    {
        string fileNameWithoutExtension = Path.GetFileNameWithoutExtension(filePath);
        string currentFolderPath = Path.GetDirectoryName(filePath);

        if (currentFolderPath.EndsWith(fileNameWithoutExtension))
        {
            Console.WriteLine("The file is already in the correct folder.");
            return filePath;
        }

        string targetFolderPath = Path.Combine(currentFolderPath, fileNameWithoutExtension);
        Directory.CreateDirectory(targetFolderPath);

        // Create a new path for the file in the new folder
        string newFilePath = Path.Combine(targetFolderPath, Path.GetFileName(filePath));

        // Move the file to the new folder
        File.Move(filePath, newFilePath);
        // Save assets and refresh the AssetDatabase
        AssetDatabase.SaveAssets();
        AssetDatabase.Refresh();
        return newFilePath;
    }


    private static void ProcessFBX(string fileToProcess, string tempPath)
    {
        var asset = AssetDatabase.LoadAssetAtPath<Object>(fileToProcess);
        if (asset == null) return;

        string fileNameWithoutExtension = Path.GetFileNameWithoutExtension(fileToProcess);
        // Extracting textures and materials
        var importer = AssetImporter.GetAtPath(fileToProcess) as ModelImporter;
        //Lets extract on a random folder so same textures/materials name dont get overriden
        string subTempPath = Path.Combine(tempPath, fileNameWithoutExtension);
        Directory.CreateDirectory(subTempPath);
        string subTempPathRelativeToAssets = PathUtils.GetRelativePathTo(Application.dataPath, subTempPath);

        if (importer != null)
        {
            importer.ExtractTextures(Path.GetDirectoryName(fileToProcess));
            importer.materialImportMode = ModelImporterMaterialImportMode.ImportStandard;
            AssetDatabase.WriteImportSettingsIfDirty(fileToProcess);
            AssetDatabase.ImportAsset(fileToProcess, ImportAssetOptions.ForceUpdate);

            var instantiated = Instantiate(AssetDatabase.LoadAssetAtPath<GameObject>(fileToProcess));
            instantiated.name = fileNameWithoutExtension.ToLower();

            if (fileToProcess.Contains("_0"))
            {
                SetDCLShaderMaterial(fileToProcess, instantiated, subTempPathRelativeToAssets, false);
                GenerateColliders(fileToProcess, instantiated);
            }
            else
                SetDCLShaderMaterial(fileToProcess, instantiated,  subTempPathRelativeToAssets, true);


            string prefabPath = tempPath + "/" + instantiated + ".prefab";
            PrefabUtility.SaveAsPrefabAsset(instantiated, prefabPath);
            DestroyImmediate(instantiated);
            // Save assets and refresh the AssetDatabase
            AssetDatabase.SaveAssets();
            AssetDatabase.Refresh();

            var prefabImporter = AssetImporter.GetAtPath(PathUtils.GetRelativePathTo(Application.dataPath, prefabPath));
            prefabImporter.SetAssetBundleNameAndVariant(fileNameWithoutExtension, "");
        }
    }

    private static void GenerateColliders(string path, GameObject instantiated)
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
                DestroyImmediate(r);
        }
    }

    private static void ConfigureColliders(Transform transform, MeshFilter filter)
    {
        if (filter != null)
        {
            Physics.BakeMesh(filter.sharedMesh.GetInstanceID(), false);
            filter.gameObject.AddComponent<MeshCollider>();
            DestroyImmediate(filter.GetComponent<MeshRenderer>());
        }

        foreach (Transform child in transform)
        {
            var f = child.gameObject.GetComponent<MeshFilter>();
            ConfigureColliders(child, f);
        }
    }

    private static void SetDCLShaderMaterial(string path, GameObject transform, string tempPath, bool setDefaultTransparency)
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
                    // Save assets and refresh the AssetDatabase
                    AssetDatabase.SaveAssets();
                    AssetDatabase.Refresh();
                    materialsDictionary.Add(materialName, AssetDatabase.LoadAssetAtPath<Material>(materialPath));
                }

                savedMaterials.Add(materialsDictionary[materialName]);
            }

            componentsInChild.sharedMaterials = savedMaterials.ToArray();
        }
    }

    private static void ApplyTransparency(Material duplicatedMaterial, bool setDefaultTransparency)
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
}