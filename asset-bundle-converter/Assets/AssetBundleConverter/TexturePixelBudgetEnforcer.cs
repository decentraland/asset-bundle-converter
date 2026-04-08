using DCL;
using DCL.ABConverter;
using System;
using System.Collections.Generic;
using System.Linq;
using UnityEditor;
using UnityEngine;
using Object = UnityEngine.Object;

namespace AssetBundleConverter
{
    public enum TextureLayer
    {
        ALBEDO,
        NORMAL,
        EMISSIVE,
        OTHER,
    }

    public class TrackedTexture
    {
        public string FilePath;
        public string Name;
        public int Width;
        public int Height;
        public long PixelCount => (long)Width * Height;
        public TextureType Types;
    }

    public class TexturePixelBudgetEnforcer
    {
        // TODO (Maurizio) hard cap?

        private const int PER_PARCEL_MAX_TEXTURE_SIZE = 2048;

        private static readonly TextureLayer[] ALL_LAYERS = (TextureLayer[])Enum.GetValues(typeof(TextureLayer));

        protected readonly Dictionary<string, TrackedTexture> trackedTextures = new();
        private readonly long budgetPerLayer;
        private readonly IFile file;
        private readonly IAssetDatabase assetDatabase;
        private readonly IABLogger log;

        public TexturePixelBudgetEnforcer(int parcelCount, IFile file, IAssetDatabase assetDatabase, IABLogger log)
        {
            budgetPerLayer = (long)PER_PARCEL_MAX_TEXTURE_SIZE * PER_PARCEL_MAX_TEXTURE_SIZE * parcelCount;
            this.file = file;
            this.assetDatabase = assetDatabase;
            this.log = log;
        }

        public void TrackTexture(string filePath, string name, int width, int height, TextureType types)
        {
            if (types == TextureType.None)
                return;

            if (trackedTextures.TryGetValue(filePath, out var existing))
            {
                existing.Types |= types;
                existing.Width = width;
                existing.Height = height;
            }
            else
                trackedTextures[filePath] = new TrackedTexture
                {
                    FilePath = filePath,
                    Name = name,
                    Width = width,
                    Height = height,
                    Types = types,
                };
        }

        public void EnforceBudgets()
        {
            foreach (var layer in ALL_LAYERS)
            {
                List<TrackedTexture> candidates = trackedTextures.Values
                                                .Where(t => GetLayers(t.Types).Contains(layer))
                                                .ToList();

                if (candidates.Count == 0) continue;

                candidates.Sort(CompareTextures);

                long totalPixels = candidates.Sum(c => c.PixelCount);

                int index = 0;

                while (totalPixels > budgetPerLayer)
                {
                    TrackedTexture candidate = candidates[index];

                    log.Verbose($"Texture budget: optimizing {candidate.FilePath}");

                    // Knowing that candidates[index + 1] would be same or less size that candidates[index]
                    // then safely assume this layer cannot be optimized further
                    if (candidate.Width <= 1 && candidate.Height <= 1)
                    {
                        log.Warning($"Texture budget for layer {layer} cannot be met, largest texture already at 1x1");
                        break;
                    }

                    long excess = totalPixels - budgetPerLayer;
                    long currentPixels = candidate.PixelCount;
                    long targetPixels = Math.Max(1, currentPixels - excess);

                    float factor = Mathf.Sqrt((float)targetPixels / currentPixels);

                    // If factor < 0.5, limit to halving the size, it will continue reducing on next iteration,
                    // this way we reduce the number of wasted pixels
                    if (factor < 0.5f)
                        factor = 0.5f;

                    int newWidth = Mathf.Max(1, (int)(candidate.Width * factor));
                    int newHeight = Mathf.Max(1, (int)(candidate.Height * factor));

                    if (newWidth == candidate.Width && newHeight == candidate.Height)
                    {
                        log.Warning($"Texture budget for layer {layer} cannot be met, no further reduction possible for {candidate.FilePath}");
                        break;
                    }

                    long oldPixels = candidate.PixelCount;
                    ResizeTrackedTexture(candidate, newWidth, newHeight);
                    totalPixels -= oldPixels - candidate.PixelCount;

                    index = (index + 1) % candidates.Count;
                }
            }
        }

        protected virtual void ResizeTrackedTexture(TrackedTexture texture, int newWidth, int newHeight)
        {
            byte[] image = file.ReadAllBytes(texture.FilePath);

            var tmpTex = new Texture2D(1, 1);

            if (!tmpTex.LoadImage(image))
            {
                Object.DestroyImmediate(tmpTex);
                log.Error($"Failed to load texture for budget resize: {texture.FilePath}");
                return;
            }

            log.Verbose($"Texture budget: resizing {texture.FilePath} from {texture.Width}x{texture.Height} to {newWidth}x{newHeight}");

            Texture2D dstTex = Utils.ResizeTexture(tmpTex, newWidth, newHeight);
            byte[] resizedBytes = dstTex.EncodeToPNG();

            Object.DestroyImmediate(tmpTex);
            Object.DestroyImmediate(dstTex);

            file.WriteAllBytes(texture.FilePath, resizedBytes);
            assetDatabase.ImportAsset(texture.FilePath, ImportAssetOptions.ForceSynchronousImport | ImportAssetOptions.ForceUpdate);

            texture.Width = newWidth;
            texture.Height = newHeight;
        }

        /// <summary>
        /// Sort by pixel count descending, then by name, then by full path for determinism.
        /// </summary>
        private static int CompareTextures(TrackedTexture a, TrackedTexture b)
        {
            int cmp = b.PixelCount.CompareTo(a.PixelCount);
            if (cmp != 0) return cmp;
            cmp = string.Compare(a.Name, b.Name, StringComparison.Ordinal);
            return cmp != 0 ? cmp : string.Compare(a.FilePath, b.FilePath, StringComparison.Ordinal);
        }

        private static HashSet<TextureLayer> GetLayers(TextureType types)
        {
            var layers = new HashSet<TextureLayer>();

            if ((types & (TextureType.MainTex | TextureType.BaseMap)) != 0)
                layers.Add(TextureLayer.ALBEDO);

            if ((types & TextureType.BumpMap) != 0)
                layers.Add(TextureLayer.NORMAL);

            if ((types & TextureType.EmissionMap) != 0)
                layers.Add(TextureLayer.EMISSIVE);

            if ((types & (TextureType.MetallicGlossMap | TextureType.OcclusionMap | TextureType.ParallaxMap | TextureType.SpecGlossMap)) != 0)
                layers.Add(TextureLayer.OTHER);

            return layers;
        }
    }
}
