using UnityEngine;
using System.Collections.Generic;
using System.Linq;

public class PBRMeshMerger : MonoBehaviour
{
    public List<MeshFilter> meshesToMerge;
    public Material opaqueMaterial;
    public Material transparentMaterial;

    private Dictionary<string, Texture2D> atlases = new Dictionary<string, Texture2D>();
    private Dictionary<Texture2D, Rect> texturePositions = new Dictionary<Texture2D, Rect>();
    private Dictionary<int, Rect> encodedValuePositions = new Dictionary<int, Rect>();

    void MergeMeshes()
    {
        Dictionary<string, HashSet<Texture2D>> uniqueTextures = new Dictionary<string, HashSet<Texture2D>>
        {
            {"albedo", new HashSet<Texture2D>()},
            {"metallic", new HashSet<Texture2D>()},
            {"normal", new HashSet<Texture2D>()},
            {"occlusion", new HashSet<Texture2D>()},
            {"emission", new HashSet<Texture2D>()}
        };

        Dictionary<string, HashSet<Color>> encodedValues = new Dictionary<string, HashSet<Color>>
        {
            {"albedo", new HashSet<Color>()},
            {"metallic", new HashSet<Color>()},
            {"emission", new HashSet<Color>()}
        };

        // Collect unique textures and encoded values for each map type
        foreach (MeshFilter meshFilter in meshesToMerge)
        {
            Renderer renderer = meshFilter.GetComponent<Renderer>();
            if (renderer != null)
            {
                Material mat = renderer.sharedMaterial;
                CollectTextureOrValue(mat, "_MainTex", "_Color", uniqueTextures["albedo"], encodedValues["albedo"]);
                CollectTextureOrValue(mat, "_MetallicGlossMap", "_Metallic", uniqueTextures["metallic"], encodedValues["metallic"]);
                CollectTexture(mat, "_BumpMap", uniqueTextures["normal"]);
                CollectTexture(mat, "_OcclusionMap", uniqueTextures["occlusion"]);
                CollectTextureOrValue(mat, "_EmissionMap", "_EmissionColor", uniqueTextures["emission"], encodedValues["emission"]);
            }
        }

        // Create atlases for each texture type, including encoded values
        foreach (var kvp in uniqueTextures)
        {
            string mapType = kvp.Key;
            HashSet<Texture2D> textures = kvp.Value;
            HashSet<Color> values = encodedValues.ContainsKey(mapType) ? encodedValues[mapType] : new HashSet<Color>();

            if (textures.Count > 0 || values.Count > 0)
            {
                int atlasSize = CalculateAtlasSize(textures, values);
                CalculateTextureAndValuePositions(textures, values, atlasSize);
                atlases[mapType] = CreateAtlas(textures, values, atlasSize, mapType == "normal");
            }
        }

        // Update UV coordinates and split meshes by transparency
        List<CombineInstance> opaqueCombine = new List<CombineInstance>();
        List<CombineInstance> transparentCombine = new List<CombineInstance>();

        foreach (MeshFilter meshFilter in meshesToMerge)
        {
            Mesh mesh = meshFilter.sharedMesh;
            Vector2[] meshUVs = mesh.uv;
            Renderer renderer = meshFilter.GetComponent<Renderer>();
            Material mat = renderer.sharedMaterial;

            bool isTransparent = IsTransparent(mat);

            // Update UVs based on texture or encoded value position
            UpdateUVs(mesh, mat);

            // Add to appropriate combine list
            CombineInstance ci = new CombineInstance
            {
                mesh = mesh,
                transform = meshFilter.transform.localToWorldMatrix
            };

            if (isTransparent)
                transparentCombine.Add(ci);
            else
                opaqueCombine.Add(ci);
        }

        // Create merged meshes
        CreateMergedObject("MergedOpaqueMesh", opaqueCombine, opaqueMaterial);
        CreateMergedObject("MergedTransparentMesh", transparentCombine, transparentMaterial);

        // Set atlas textures to materials
        SetMaterialTextures(opaqueMaterial);
        SetMaterialTextures(transparentMaterial);

        // Optionally, disable or destroy original objects
        foreach (MeshFilter mf in meshesToMerge)
        {
            mf.gameObject.SetActive(false);
        }
    }

    void CollectTextureOrValue(Material mat, string textureProp, string colorProp, HashSet<Texture2D> textureSet, HashSet<Color> valueSet)
    {
        if (mat.HasProperty(textureProp) && mat.GetTexture(textureProp) != null)
        {
            textureSet.Add(mat.GetTexture(textureProp) as Texture2D);
        }
        else if (mat.HasProperty(colorProp))
        {
            valueSet.Add(mat.GetColor(colorProp));
        }
    }

    void CollectTexture(Material mat, string propertyName, HashSet<Texture2D> textureSet)
    {
        if (mat.HasProperty(propertyName) && mat.GetTexture(propertyName) != null)
        {
            textureSet.Add(mat.GetTexture(propertyName) as Texture2D);
        }
    }

    bool IsTransparent(Material mat)
    {
        return mat.renderQueue > 2500 || mat.HasProperty("_Mode") && mat.GetFloat("_Mode") > 0;
    }

    int CalculateAtlasSize(HashSet<Texture2D> textures, HashSet<Color> values)
    {
        int totalArea = textures.Sum(t => t.width * t.height) + values.Count;
        int size = Mathf.NextPowerOfTwo(Mathf.CeilToInt(Mathf.Sqrt(totalArea)));
        return Mathf.Min(size, 8192); // Limit to 8192x8192 (adjust as needed)
    }

    void CalculateTextureAndValuePositions(HashSet<Texture2D> textures, HashSet<Color> values, int atlasSize)
    {
        int x = 0, y = 0;
        int rowHeight = 0;

        // Position textures
        foreach (Texture2D texture in textures)
        {
            if (x + texture.width > atlasSize)
            {
                x = 0;
                y += rowHeight;
                rowHeight = 0;
            }

            texturePositions[texture] = new Rect(
                (float)x / atlasSize,
                (float)y / atlasSize,
                (float)texture.width / atlasSize,
                (float)texture.height / atlasSize
            );

            x += texture.width;
            rowHeight = Mathf.Max(rowHeight, texture.height);
        }

        // Position encoded values (1x1 pixel each)
        foreach (Color value in values)
        {
            if (x + 1 > atlasSize)
            {
                x = 0;
                y += rowHeight;
                rowHeight = 1;
            }

            encodedValuePositions[value.GetHashCode()] = new Rect(
                (float)x / atlasSize,
                (float)y / atlasSize,
                1f / atlasSize,
                1f / atlasSize
            );

            x += 1;
            rowHeight = Mathf.Max(rowHeight, 1);
        }
    }

    Texture2D CreateAtlas(HashSet<Texture2D> textures, HashSet<Color> values, int atlasSize, bool isNormalMap)
    {
        Texture2D atlas = new Texture2D(atlasSize, atlasSize, TextureFormat.RGBA32, true);

        // Copy textures to atlas
        foreach (var kvp in texturePositions)
        {
            Texture2D texture = kvp.Key;
            Rect position = kvp.Value;

            int x = Mathf.FloorToInt(position.x * atlasSize);
            int y = Mathf.FloorToInt(position.y * atlasSize);

            Color[] pixels = texture.GetPixels();
            if (isNormalMap)
                pixels = ProcessNormalMap(pixels);

            atlas.SetPixels(x, y, texture.width, texture.height, pixels);
        }

        // Encode single values into atlas
        foreach (var kvp in encodedValuePositions)
        {
            Color value = values.First(c => c.GetHashCode() == kvp.Key);
            Rect position = kvp.Value;

            int x = Mathf.FloorToInt(position.x * atlasSize);
            int y = Mathf.FloorToInt(position.y * atlasSize);

            atlas.SetPixel(x, y, value);
        }

        atlas.Apply();
        return atlas;
    }

    Color[] ProcessNormalMap(Color[] pixels)
    {
        for (int i = 0; i < pixels.Length; i++)
        {
            pixels[i] = new Color(pixels[i].r, pixels[i].g, pixels[i].b, 1);
        }
        return pixels;
    }

    void UpdateUVs(Mesh mesh, Material mat)
    {
        Vector2[] meshUVs = mesh.uv;
        bool uvUpdated = false;

        string[] propertyNames = { "_MainTex", "_MetallicGlossMap", "_BumpMap", "_OcclusionMap", "_EmissionMap" };
        string[] colorProperties = { "_Color", "_Metallic", "", "", "_EmissionColor" };

        for (int i = 0; i < propertyNames.Length; i++)
        {
            string textureProp = propertyNames[i];
            string colorProp = colorProperties[i];

            if (mat.HasProperty(textureProp) && mat.GetTexture(textureProp) is Texture2D texture && texturePositions.TryGetValue(texture, out Rect uvRect))
            {
                for (int j = 0; j < meshUVs.Length; j++)
                {
                    meshUVs[j] = new Vector2(
                        uvRect.x + meshUVs[j].x * uvRect.width,
                        uvRect.y + meshUVs[j].y * uvRect.height
                    );
                }
                uvUpdated = true;
                break;
            }
            else if (!string.IsNullOrEmpty(colorProp) && mat.HasProperty(colorProp))
            {
                Color value = mat.GetColor(colorProp);
                if (encodedValuePositions.TryGetValue(value.GetHashCode(), out Rect valueRect))
                {
                    for (int j = 0; j < meshUVs.Length; j++)
                    {
                        meshUVs[j] = new Vector2(valueRect.x + 0.5f / atlases[textureProp].width, valueRect.y + 0.5f / atlases[textureProp].height);
                    }
                    uvUpdated = true;
                    break;
                }
            }
        }

        if (uvUpdated)
        {
            mesh.uv = meshUVs;
        }
    }

    void CreateMergedObject(string name, List<CombineInstance> combines, Material material)
    {
        if (combines.Count == 0) return;

        Mesh mergedMesh = new Mesh();
        mergedMesh.CombineMeshes(combines.ToArray());

        GameObject mergedObject = new GameObject(name);
        MeshFilter meshFilter = mergedObject.AddComponent<MeshFilter>();
        meshFilter.sharedMesh = mergedMesh;

        MeshRenderer meshRenderer = mergedObject.AddComponent<MeshRenderer>();
        meshRenderer.sharedMaterial = material;
    }

    void SetMaterialTextures(Material material)
    {
        if (atlases.TryGetValue("albedo", out Texture2D albedoAtlas))
            material.SetTexture("_MainTex", albedoAtlas);

        if (atlases.TryGetValue("metallic", out Texture2D metallicAtlas))
            material.SetTexture("_MetallicGlossMap", metallicAtlas);

        if (atlases.TryGetValue("normal", out Texture2D normalAtlas))
            material.SetTexture("_BumpMap", normalAtlas);

        if (atlases.TryGetValue("occlusion", out Texture2D occlusionAtlas))
            material.SetTexture("_OcclusionMap", occlusionAtlas);

        if (atlases.TryGetValue("emission", out Texture2D emissionAtlas))
            material.SetTexture("_EmissionMap", emissionAtlas);
    }
}