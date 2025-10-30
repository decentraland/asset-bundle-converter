using UnityEngine;
using System.Collections.Generic;
using System.Linq;

public class QuadtreeAtlasCreator : MonoBehaviour
{
    [SerializeField] public List<Texture2D> texturesToPack;
    [SerializeField] private bool useBC7Compression = true;

    private QuadtreeTextureAtlasPacker.PackingResult currentPackingResult;
    private Texture2D atlasTexture;

    public void CreateAtlas()
    {
        if (texturesToPack == null || texturesToPack.Count == 0)
        {
            Debug.LogError("No textures to pack!");
            return;
        }

        // Pack textures
        currentPackingResult = QuadtreeTextureAtlasPacker.Pack(texturesToPack, 4096);

        if (currentPackingResult == null)
        {
            Debug.LogError("Failed to pack textures!");
            return;
        }

        Debug.Log($"Successfully packed {currentPackingResult.packedTextures.Count} textures");
        Debug.Log($"Atlas size: {currentPackingResult.atlasSize}x{currentPackingResult.atlasSize}");
        Debug.Log($"Efficiency: {currentPackingResult.efficiency:P1}");

        // Create atlas texture
        CreateAtlasTexture();

        // Log packing details
        LogPackingDetails();
    }

    private void CreateAtlasTexture()
    {
        int size = currentPackingResult.atlasSize;

        // Create initial texture as RGBA32 for pixel manipulation
        atlasTexture = new Texture2D(size, size, TextureFormat.RGBA32, true);
        atlasTexture.name = "TextureAtlas";

        // Clear to transparent black
        Color32[] clearPixels = new Color32[size * size];
        atlasTexture.SetPixels32(clearPixels);

        // Copy each packed texture
        foreach (QuadtreeTextureAtlasPacker.PackedTexture packed in currentPackingResult.packedTextures)
        {
            CopyTextureToAtlas(packed);
        }

        // Apply changes and generate mipmaps
        atlasTexture.Apply(true, false);

        // Compress if desired
        if (useBC7Compression)
        {
            #if UNITY_EDITOR
            UnityEditor.EditorUtility.CompressTexture(atlasTexture, TextureFormat.BC7,
                UnityEditor.TextureCompressionQuality.Best);
            #endif
        }

        Debug.Log($"Atlas texture created: {atlasTexture.name} ({size}x{size})");
    }

    private void CopyTextureToAtlas(QuadtreeTextureAtlasPacker.PackedTexture packed)
    {
        // Make source texture readable
        RenderTexture tempRT = RenderTexture.GetTemporary(
            packed.texture.width,
            packed.texture.height,
            0,
            RenderTextureFormat.Default,
            RenderTextureReadWrite.Linear
        );

        Graphics.Blit(packed.texture, tempRT);
        RenderTexture previous = RenderTexture.active;
        RenderTexture.active = tempRT;

        Texture2D readable = new Texture2D(packed.width, packed.height);
        readable.ReadPixels(new Rect(0, 0, tempRT.width, tempRT.height), 0, 0);
        readable.Apply();

        RenderTexture.active = previous;
        RenderTexture.ReleaseTemporary(tempRT);

        // Copy pixels to atlas
        Color[] pixels = readable.GetPixels();
        atlasTexture.SetPixels(packed.x, packed.y, packed.width, packed.height, pixels);

        // Cleanup
        if (Application.isPlaying)
            Destroy(readable);
        else
            DestroyImmediate(readable);
    }

    private void LogPackingDetails()
    {
        Debug.Log("=== Packing Details ===");
        foreach (QuadtreeTextureAtlasPacker.PackedTexture packed in currentPackingResult.packedTextures)
        {
            Debug.Log($"Texture[{packed.originalIndex}] '{packed.texture.name}': " +
                     $"{packed.width}x{packed.height} at position ({packed.x}, {packed.y})");
        }
    }

    /// <summary>
    /// Remap mesh UVs for a specific texture index
    /// </summary>
    public void RemapMeshUVs(MeshFilter meshFilter, int textureIndex)
    {
        if (currentPackingResult == null)
        {
            Debug.LogError("No packing result available!");
            return;
        }

        QuadtreeTextureAtlasPacker.PackedTexture packed = currentPackingResult.packedTextures.FirstOrDefault(p => p.originalIndex == textureIndex);
        if (packed == null)
        {
            Debug.LogError($"Texture index {textureIndex} not found in packing!");
            return;
        }

        Mesh mesh = meshFilter.mesh;
        Vector2[] originalUVs = mesh.uv;
        Vector2[] remappedUVs = new Vector2[originalUVs.Length];

        for (int i = 0; i < originalUVs.Length; i++)
        {
            remappedUVs[i] = QuadtreeTextureAtlasPacker.RemapUV(
                originalUVs[i],
                packed,
                currentPackingResult.atlasSize
            );
        }

        mesh.uv = remappedUVs;
        meshFilter.mesh = mesh;
    }

    /// <summary>
    /// Visualize the quadtree structure in the editor
    /// </summary>
    private void OnDrawGizmos()
    {
        if (currentPackingResult?.rootNode != null)
        {
            DrawQuadtreeNode(currentPackingResult.rootNode);
        }
    }

    private void DrawQuadtreeNode(QuadtreeTextureAtlasPacker.QuadNode node)
    {
        if (node == null) return;

        Vector3 center = new Vector3(node.x + node.size * 0.5f, 0, node.y + node.size * 0.5f) * 0.01f;
        Vector3 size = new Vector3(node.size, 0.1f, node.size) * 0.01f;

        if (node.texture != null)
        {
            Gizmos.color = Color.green;
            Gizmos.DrawWireCube(center, size);
        }
        else if (node.children != null)
        {
            foreach (QuadtreeTextureAtlasPacker.QuadNode child in node.children)
            {
                DrawQuadtreeNode(child);
            }
        }
    }
}
