using System.Collections.Generic;
using UnityEngine;

namespace AssetBundleConverter.TextureAtlas
{
    /// <summary>
    /// Builds a Texture2D atlas by blitting source textures into positions described by a TextureAtlasLayout.
    /// Source textures must have Read/Write enabled.
    /// Extracted from MB3_TextureCombinerPackerMeshBaker.CopyScaledAndTiledToAtlas.
    /// </summary>
    public static class TextureAtlasBuilder
    {
        /// <summary>
        /// Blits each source texture into the atlas using bilinear sampling, then bleeds border pixels
        /// into the padding zone to prevent seam artifacts.
        /// </summary>
        /// <param name="sourceTextures">The original textures to pack.</param>
        /// <param name="layout">Layout produced by <see cref="TextureAtlasPacker.Pack"/>.</param>
        /// <param name="isLinear">Whether to create the atlas in linear color space.</param>
        /// <returns>A new Texture2D containing the atlas. Apply() has already been called.</returns>
        public static Texture2D Build(IList<Texture2D> sourceTextures, TextureAtlasLayout layout, bool isLinear = false)
        {
            int atlasW = layout.AtlasWidth;
            int atlasH = layout.AtlasHeight;
            // int padding = layout.Padding;

            // Flat row-major pixel buffer: index = y * atlasW + x
            var pixels = new Color[atlasW * atlasH];

            for (int rectIdx = 0; rectIdx < layout.UVRects.Length; rectIdx++)
            {
                int srcIdx = layout.SourceIndices[rectIdx];
                Texture2D src = sourceTextures[srcIdx];
                Rect uvRect = layout.UVRects[rectIdx];

                // Convert normalized rect back to atlas pixel coords (content area, no padding)
                int targX = Mathf.RoundToInt(uvRect.x * atlasW);
                int targY = Mathf.RoundToInt(uvRect.y * atlasH);
                int w = Mathf.RoundToInt(uvRect.width * atlasW);
                int h = Mathf.RoundToInt(uvRect.height * atlasH);

                if (w == 0 || h == 0)
                {
                    Debug.LogWarning($"[TextureAtlasBuilder] Skipping zero-size rect for source index {srcIdx}.");
                    continue;
                }

                // Blit source into atlas using bilinear sampling
                for (int pi = 0; pi < w; pi++)
                {
                    for (int pj = 0; pj < h; pj++)
                    {
                        float u = (float)pi / w;
                        float v = (float)pj / h;
                        pixels[(targY + pj) * atlasW + (targX + pi)] = src.GetPixelBilinear(u, v);
                    }
                }

            //     if (padding <= 0)
            //         continue;
            //
            //     // Bleed top and bottom borders into padding zone
            //     for (int pi = 0; pi < w; pi++)
            //     {
            //         for (int pj = 1; pj <= padding; pj++)
            //         {
            //             // below content (decreasing y = visual top in Unity UV space)
            //             pixels[(targY - pj) * atlasW + (targX + pi)] =
            //                 pixels[targY * atlasW + (targX + pi)];
            //             // above content
            //             pixels[(targY + h - 1 + pj) * atlasW + (targX + pi)] =
            //                 pixels[(targY + h - 1) * atlasW + (targX + pi)];
            //         }
            //     }
            //
            //     // Bleed left and right borders into padding zone
            //     for (int pj = 0; pj < h; pj++)
            //     {
            //         for (int pi = 1; pi <= padding; pi++)
            //         {
            //             // left of content
            //             pixels[(targY + pj) * atlasW + (targX - pi)] =
            //                 pixels[(targY + pj) * atlasW + targX];
            //             // right of content
            //             pixels[(targY + pj) * atlasW + (targX + w + pi - 1)] =
            //                 pixels[(targY + pj) * atlasW + (targX + w - 1)];
            //         }
            //     }
            //
            //     // Fill corners of the padding zone
            //     for (int pi = 1; pi <= padding; pi++)
            //     {
            //         for (int pj = 1; pj <= padding; pj++)
            //         {
            //             pixels[(targY - pj) * atlasW + (targX - pi)] =
            //                 pixels[targY * atlasW + targX];
            //             pixels[(targY + h - 1 + pj) * atlasW + (targX - pi)] =
            //                 pixels[(targY + h - 1) * atlasW + targX];
            //             pixels[(targY + h - 1 + pj) * atlasW + (targX + w + pi - 1)] =
            //                 pixels[(targY + h - 1) * atlasW + (targX + w - 1)];
            //             pixels[(targY - pj) * atlasW + (targX + w + pi - 1)] =
            //                 pixels[targY * atlasW + (targX + w - 1)];
            //         }
            //     }
            }

            var atlas = new Texture2D(atlasW, atlasH, TextureFormat.ARGB32, mipChain: true, linear: isLinear);
            atlas.SetPixels(pixels);
            atlas.Apply();
            return atlas;
        }
    }
}
