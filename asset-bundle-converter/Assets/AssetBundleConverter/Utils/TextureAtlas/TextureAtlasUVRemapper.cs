using System.Collections.Generic;
using UnityEngine;

namespace AssetBundleConverter.TextureAtlas
{
    /// <summary>
    /// Remaps mesh UV coordinates into a sub-region of a texture atlas.
    /// </summary>
    public static class TextureAtlasUVRemapper
    {
        /// <summary>
        /// Transforms every UV in <paramref name="uvChannel"/> from [0,1] local texture space
        /// into the normalized atlas rect: newUV = atlasRect.min + uv * atlasRect.size.
        /// </summary>
        /// <param name="mesh">The mesh whose UVs will be modified in-place.</param>
        /// <param name="atlasRect">The normalized [0,1] UV rect from <see cref="TextureAtlasLayout.UVRects"/>.</param>
        /// <param name="uvChannel">UV channel index (0 = mesh.uv, 1 = mesh.uv2, etc.).</param>
        public static void RemapUVs(Mesh mesh, Rect atlasRect, int uvChannel = 0)
        {
            var uvs = new List<Vector2>();
            mesh.GetUVs(uvChannel, uvs);

            Vector2 min = atlasRect.min;
            Vector2 size = atlasRect.size;

            for (int i = 0; i < uvs.Count; i++)
                uvs[i] = min + uvs[i] * size;

            mesh.SetUVs(uvChannel, uvs);
        }
    }
}
