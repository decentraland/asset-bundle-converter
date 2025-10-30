using System;
using System.Collections.Generic;
using System.Linq;
using UnityEngine;

public class QuadtreeTextureAtlasPacker
{
    [System.Serializable]
    public class PackedTexture
    {
        public Texture2D texture;
        public int x, y, width, height;
        public int originalIndex;

        public PackedTexture(Texture2D tex, int index)
        {
            texture = tex;
            width = tex.width;
            height = tex.height;
            originalIndex = index;
        }
    }

    public class PackingResult
    {
        public int atlasSize; // Square, power of 2
        public List<PackedTexture> packedTextures;
        public float efficiency;
        public QuadNode rootNode; // For debugging/visualization

        public PackingResult(int size)
        {
            atlasSize = size;
            packedTextures = new List<PackedTexture>();
        }
    }

    public class QuadNode
    {
        public int x, y, size;
        public QuadNode[] children; // null if leaf, 4 children if subdivided
        public bool occupied;
        public PackedTexture texture; // Only set if this node contains a texture

        public QuadNode(int x, int y, int size)
        {
            this.x = x;
            this.y = y;
            this.size = size;
            this.occupied = false;
            this.children = null;
            this.texture = null;
        }

        /// <summary>
        /// Try to insert a texture into this node or its children
        /// </summary>
        public bool Insert(PackedTexture tex)
        {
            // If this node has children, it's not a leaf - try children
            if (children != null)
            {
                // Try each quadrant
                for (int i = 0; i < 4; i++)
                {
                    if (children[i].Insert(tex))
                        return true;
                }
                return false;
            }

            // This is a leaf node
            if (occupied)
                return false;

            // Check if texture fits
            if (tex.width > size || tex.height > size)
                return false;

            // Perfect fit - no need to subdivide
            if (tex.width == size && tex.height == size)
            {
                occupied = true;
                texture = tex;
                tex.x = x;
                tex.y = y;
                return true;
            }

            // Texture fits but node is too big - need to subdivide
            // Only subdivide if we can (size must be at least 2)
            if (size == 1)
                return false;

            Subdivide();

            // Try to insert into one of the new children
            for (int i = 0; i < 4; i++)
            {
                if (children[i].Insert(tex))
                {
                    occupied = true; // Mark parent as occupied
                    return true;
                }
            }

            return false;
        }

        private void Subdivide()
        {
            int halfSize = size / 2;
            children = new QuadNode[4];

            // Create 4 children (quadrants)
            // Bottom-left (0)
            children[0] = new QuadNode(x, y, halfSize);
            // Bottom-right (1)
            children[1] = new QuadNode(x + halfSize, y, halfSize);
            // Top-left (2)
            children[2] = new QuadNode(x, y + halfSize, halfSize);
            // Top-right (3)
            children[3] = new QuadNode(x + halfSize, y + halfSize, halfSize);
        }

        /// <summary>
        /// Get all occupied leaf nodes for visualization
        /// </summary>
        public void GetOccupiedNodes(List<QuadNode> nodes)
        {
            if (children != null)
            {
                foreach (QuadNode child in children)
                {
                    child.GetOccupiedNodes(nodes);
                }
            }
            else if (texture != null)
            {
                nodes.Add(this);
            }
        }
    }

    /// <summary>
    /// Pack textures into a square, power-of-2 atlas
    /// </summary>
    public static PackingResult Pack(List<Texture2D> textures, int maxAtlasSize = 4096)
    {
        if (textures == null || textures.Count == 0)
            return null;

        // Create packed texture list and sort by area (largest first)
        List<PackedTexture> packedTextures = new List<PackedTexture>();
        for (int i = 0; i < textures.Count; i++)
        {
            // Validate texture is power of 2
            if (!IsPowerOfTwo(textures[i].width) || !IsPowerOfTwo(textures[i].height))
            {
                Debug.LogWarning($"Texture {textures[i].name} dimensions are not power of 2: {textures[i].width}x{textures[i].height}");
            }
            packedTextures.Add(new PackedTexture(textures[i], i));
        }

        // Sort by area descending, then by max dimension for better packing
        packedTextures.Sort((a, b) =>
        {
            int areaCompare = (b.width * b.height).CompareTo(a.width * a.height);
            if (areaCompare != 0) return areaCompare;
            return Math.Max(b.width, b.height).CompareTo(Math.Max(a.width, a.height));
        });

        // Find minimum required atlas size
        int minSize = CalculateMinimumAtlasSize(packedTextures);

        // Try progressively larger atlas sizes
        for (int atlasSize = minSize; atlasSize <= maxAtlasSize; atlasSize *= 2)
        {
            PackingResult result = TryPackAtSize(packedTextures, atlasSize);
            if (result != null)
            {
                CalculateEfficiency(result);
                return result;
            }
        }

        Debug.LogError($"Failed to pack {textures.Count} textures into {maxAtlasSize}x{maxAtlasSize} atlas");
        return null;
    }

    private static PackingResult TryPackAtSize(List<PackedTexture> textures, int atlasSize)
    {
        QuadNode root = new QuadNode(0, 0, atlasSize);
        PackingResult result = new PackingResult(atlasSize);
        result.rootNode = root;

        foreach (PackedTexture tex in textures)
        {
            if (root.Insert(tex))
            {
                result.packedTextures.Add(tex);
            }
            else
            {
                // Packing failed at this size
                return null;
            }
        }

        return result;
    }

    private static int CalculateMinimumAtlasSize(List<PackedTexture> textures)
    {
        int totalArea = 0;
        int maxDimension = 0;

        foreach (PackedTexture tex in textures)
        {
            totalArea += tex.width * tex.height;
            maxDimension = Math.Max(maxDimension, Math.Max(tex.width, tex.height));
        }

        // Theoretical minimum size
        int minSize = Mathf.CeilToInt(Mathf.Sqrt(totalArea));

        // Must be at least as large as the largest texture
        minSize = Math.Max(minSize, maxDimension);

        // Round up to power of 2
        return Mathf.NextPowerOfTwo(minSize);
    }

    private static void CalculateEfficiency(PackingResult result)
    {
        int usedArea = 0;
        foreach (PackedTexture tex in result.packedTextures)
        {
            usedArea += tex.width * tex.height;
        }

        int totalArea = result.atlasSize * result.atlasSize;
        result.efficiency = (float)usedArea / totalArea;
    }

    private static bool IsPowerOfTwo(int value)
    {
        return value > 0 && (value & (value - 1)) == 0;
    }

    /// <summary>
    /// Remap UV coordinates for a packed texture
    /// </summary>
    public static Vector2 RemapUV(Vector2 originalUV, PackedTexture packed, int atlasSize)
    {
        float uScale = (float)packed.width / atlasSize;
        float vScale = (float)packed.height / atlasSize;
        float uOffset = (float)packed.x / atlasSize;
        float vOffset = (float)packed.y / atlasSize;

        return new Vector2(
            originalUV.x * uScale + uOffset,
            originalUV.y * vScale + vOffset
        );
    }

    /// <summary>
    /// Get the UV rect for a packed texture
    /// </summary>
    public static Rect GetUVRect(PackedTexture packed, int atlasSize)
    {
        return new Rect(
            (float)packed.x / atlasSize,
            (float)packed.y / atlasSize,
            (float)packed.width / atlasSize,
            (float)packed.height / atlasSize
        );
    }
}
