using System.Collections.Generic;
using System.IO;
using System.Text.RegularExpressions;
using UnityEditor;
using UnityEngine;
using UnityEditor.PixyzPlugin4Unity.UI;

public class DCLSetupMaterialsAndTextures : ActionInOut<IList<GameObject>, IList<GameObject>> {


    public int lodLevel = 1;

    public override int id { get { return 137203808;} }
    public override string menuPathRuleEngine { get { return "DCL/Setup Materials and textures";} }
    public override string menuPathToolbox { get { return null;} }
    public override string tooltip { get { return "Setup materials and textures";} }

    public override IList<GameObject> run(IList<GameObject> input)
    {
        string path = CreateLODFolder(input[0].gameObject.name);
        CopyMaterials(input, path);
        return input;
    }

    string CreateLODFolder(string hashName)
    {
        string absolutePath = $"{Application.dataPath}/_Downloaded/{hashName}_lod{lodLevel.ToString()}";
        Directory.CreateDirectory(absolutePath);
        Directory.CreateDirectory(absolutePath + "/Materials");
        Directory.CreateDirectory(absolutePath + "/Textures");
        return FullPathToAssetPath(absolutePath);
    }

    void CopyMaterials(IList<GameObject> input, string path)
    {
        foreach (GameObject gameObject in input)
        {
            if (gameObject.GetComponent<Renderer>())
            {
                List<Material> newMaterial = new List<Material>();

                foreach (Material material in gameObject.GetComponent<Renderer>().sharedMaterials)
                {
                    if (material != null)
                        newMaterial.Add(CopyMaterialPropertiesWithTextures(material, path));
                    else
                        Debug.LogError($"[Lod Generator] Trying to copy a null material for {path}");
                }
                AssetDatabase.SaveAssets();
                gameObject.GetComponent<Renderer>().sharedMaterials = newMaterial.ToArray();
            }
            else
            {
                Debug.LogError("[Lod Generator] No renderer in " + gameObject + " for parent " + input[0].gameObject.name);
            }
        }
    }

    Material CopyMaterialPropertiesWithTextures(Material selectedMaterial, string path)
    {
        string pathToMaterial = $"{path}/Materials/{selectedMaterial.name.Replace(" (Instance)", "")}.mat";

        if (File.Exists(pathToMaterial))
            return AssetDatabase.LoadAssetAtPath<Material>(pathToMaterial);

        // Create a new material
        Material newMaterial = new Material(selectedMaterial.shader);

        // Copy all properties from the selected material to the new material
        newMaterial.CopyPropertiesFromMaterial(selectedMaterial);

        // Copy the textures referenced by the material
        CopyTextures(selectedMaterial, newMaterial, path);

        // Generate a new file path for the new material based on the original file name
        string newMaterialPath = AssetDatabase.GenerateUniqueAssetPath(pathToMaterial);

        // Save the new material to disk
        AssetDatabase.CreateAsset(newMaterial, newMaterialPath);
        AssetDatabase.SaveAssets();

        return newMaterial;
    }

    void CopyTextures(Material sourceMaterial, Material targetMaterial, string path)
    {
        for (int i = 0; i < ShaderUtil.GetPropertyCount(sourceMaterial.shader); i++)
        {
            if (ShaderUtil.GetPropertyType(sourceMaterial.shader, i) == ShaderUtil.ShaderPropertyType.TexEnv)
            {
                string propertyName = ShaderUtil.GetPropertyName(sourceMaterial.shader, i);
                Texture originalTexture = sourceMaterial.GetTexture(propertyName);
                if (originalTexture != null)
                {
                    string texturePath = AssetDatabase.GetAssetPath(originalTexture);
                    string newTexturePath = $"{path}/Textures/{Path.GetFileName(texturePath)}";
                    Texture newTexture = null;

                    if (!File.Exists(newTexturePath))
                    {
                        //We copy the texture
                        newTexturePath = AssetDatabase.GenerateUniqueAssetPath($"{path}/Textures/{Path.GetFileName(texturePath)}");
                        AssetDatabase.CopyAsset(texturePath, newTexturePath);

                        //We reimport and downsize it to a maximum size
                        AssetDatabase.ImportAsset(newTexturePath, ImportAssetOptions.ForceUpdate);
                        TextureImporter textureImporter = (TextureImporter)AssetImporter.GetAtPath(newTexturePath);
                        textureImporter.maxTextureSize = Mathf.Clamp(originalTexture.width / (lodLevel * 2), 64, originalTexture.width);
                        textureImporter.SaveAndReimport();
                    }

                    newTexture = AssetDatabase.LoadAssetAtPath<Texture>(newTexturePath);
                    targetMaterial.SetTexture(propertyName, newTexture);
                }
            }
            AssetDatabase.SaveAssets();
        }
    }
    string FullPathToAssetPath(string fullPath)
    {
        char ps = Path.DirectorySeparatorChar;

        fullPath = fullPath.Replace('/', ps);
        fullPath = fullPath.Replace('\\', ps);

        string pattern = $".*?\\{ps}(?<assetpath>Assets\\{ps}.*?$)";

        var regex = new Regex(pattern);

        var match = regex.Match(fullPath);

        if (match.Success && match.Groups["assetpath"] != null)
            return match.Groups["assetpath"].Value;

        return fullPath;
    }

}
