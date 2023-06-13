using System.Collections.Generic;
using System.IO;
using System.Text.RegularExpressions;
using UnityEditor;
using UnityEngine;
using UnityEditor.PixyzPlugin4Unity.UI;

public class DCLSetupExport : ActionInOut<IList<GameObject>, IList<GameObject>> {


    public int lodLevel = 1;

    public override int id { get { return 137203808;} }
    public override string menuPathRuleEngine { get { return "DCL/Setup Export";} }
    public override string menuPathToolbox { get { return null;} }
    public override string tooltip { get { return "Setup export";} }

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
        //AssetDatabase.Refresh();
        return FullPathToAssetPath(absolutePath);
    }

    void CopyMaterials(IList<GameObject> input, string path)
    {
        foreach (GameObject gameObject in input)
        {
            List<Material> newMaterial = new List<Material>();
            foreach (Material material in gameObject.GetComponent<Renderer>().materials)
                newMaterial.Add(CopyMaterialPropertiesWithTextures(material, path));
            AssetDatabase.SaveAssets();
            //AssetDatabase.Refresh();

            gameObject.GetComponent<Renderer>().materials = newMaterial.ToArray();
        }
    }

    Material CopyMaterialPropertiesWithTextures(Material selectedMaterial, string path)
    {
        Material newMaterial = null;
        if (selectedMaterial != null)
        {
            // Create a new material
            newMaterial = new Material(selectedMaterial.shader);

            // Copy all properties from the selected material to the new material
            newMaterial.CopyPropertiesFromMaterial(selectedMaterial);

            // Copy the textures referenced by the material
            CopyTextures(selectedMaterial, newMaterial, path);

            // Generate a new file path for the new material based on the original file name
            string newMaterialPath = AssetDatabase.GenerateUniqueAssetPath($"{path}/Materials/{selectedMaterial.name.Replace(" (Instance)", "")}.mat");

            // Save the new material to disk
            AssetDatabase.CreateAsset(newMaterial, newMaterialPath);
            AssetDatabase.SaveAssets();
            //AssetDatabase.Refresh();

            Debug.Log("Material properties and textures copied and saved to: " + newMaterialPath);
        }
        else
        {
            Debug.LogError("No material file selected!");
        }

        return newMaterial;
    }

    void CopyTextures(Material sourceMaterial, Material targetMaterial, string path)
    {
        for (int i = 0; i < ShaderUtil.GetPropertyCount(sourceMaterial.shader); i++)
        {
            if (ShaderUtil.GetPropertyType(sourceMaterial.shader, i) == ShaderUtil.ShaderPropertyType.TexEnv)
            {
                string propertyName = ShaderUtil.GetPropertyName(sourceMaterial.shader, i);
                Texture texture = sourceMaterial.GetTexture(propertyName);
                if (texture != null)
                {
                    string texturePath = AssetDatabase.GetAssetPath(texture);
                    string newTexturePath = $"{path}/Textures/{Path.GetFileName(texturePath)}";
                    Texture newTexture = null;

                    if (!File.Exists(newTexturePath))
                    {
                        newTexturePath = AssetDatabase.GenerateUniqueAssetPath($"{path}/Textures/{Path.GetFileName(texturePath)}");
                        AssetDatabase.CopyAsset(texturePath, newTexturePath);
                        newTexture = AssetDatabase.LoadAssetAtPath<Texture>(newTexturePath);
                    }
                    else
                        newTexture = AssetDatabase.LoadAssetAtPath<Texture>(newTexturePath);

                    targetMaterial.SetTexture(propertyName, newTexture);
                }
            }
            AssetDatabase.SaveAssets();
            //AssetDatabase.Refresh();
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
