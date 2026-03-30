using UnityEngine;

namespace AssetBundleConverter.TextureAtlas
{
    /// <summary>
    /// Shared data contract produced by TextureAtlasPacker and consumed by TextureAtlasBuilder and TextureAtlasUVRemapper.
    /// UVRects are normalized [0,1] and represent content area only (padding excluded).
    /// UVRects[i] corresponds to the source texture at sourceTextures[SourceIndices[i]].
    /// </summary>
    public class TextureAtlasLayout
    {
        /// <summary>Final atlas pixel width.</summary>
        public int AtlasWidth;

        /// <summary>Final atlas pixel height.</summary>
        public int AtlasHeight;

        /// <summary>Normalized [0,1] UV rect per packed entry (content area, no padding).</summary>
        public Rect[] UVRects;

        /// <summary>Maps UVRects[i] back to the original input texture index.</summary>
        public int[] SourceIndices;

        // /// <summary>Padding used during packing (pixels). Needed by TextureAtlasBuilder for border bleed.</summary>
        // public int Padding;
    }
}
