using System.Collections.Generic;
using UnityEngine;

namespace AssetBundleConverter.TextureAtlas
{
    public class TextureAtlasAssignment
    {
        public int AtlasSize;
        public int AtlasCount => Groups.Length;
        public int[][] Groups;
    }

    /// <summary>
    /// Plans which textures go into which atlas without touching any pixels.
    /// Uses a First Fit Decreasing (FFD) algorithm by pixel area.
    /// For POT textures packed into a POT atlas, total area ≤ atlasSize² guarantees
    /// the guillotine packer will always fit the group — area is an exact proxy.
    /// </summary>
    public static class TextureAtlasPlanner
    {
        private class AtlasGroup
        {
            public List<int> Indices = new List<int>();
            public long UsedArea;
        }

        public static TextureAtlasAssignment Plan(
            IList<Texture2D> textures,
            int atlasSize = 2048,
            int maxAtlases = -1)
        {
            Debug.Log($"[TextureAtlas] TextureAtlasPlanner.Plan: {textures?.Count ?? 0} texture(s), atlasSize={atlasSize}, maxAtlases={maxAtlases}.");

            if (textures == null || textures.Count == 0)
                return new TextureAtlasAssignment { AtlasSize = atlasSize, Groups = new int[0][] };

            long atlasArea = (long)atlasSize * atlasSize;

            // Validate all textures before doing any grouping
            bool hasErrors = false;
            for (int i = 0; i < textures.Count; i++)
            {
                var tex = textures[i];
                if (tex == null)
                {
                    Debug.LogError($"[TextureAtlasPlanner] Texture at index {i} is null.");
                    hasErrors = true;
                    continue;
                }
                if (!TextureAtlasPacker.IsPowerOfTwo(tex.width) || !TextureAtlasPacker.IsPowerOfTwo(tex.height))
                {
                    Debug.LogError($"[TextureAtlasPlanner] Texture '{tex.name}' (index {i}) size {tex.width}x{tex.height} is not power-of-two.");
                    hasErrors = true;
                }
                if (tex.width > atlasSize || tex.height > atlasSize)
                {
                    Debug.LogError($"[TextureAtlasPlanner] Texture '{tex.name}' (index {i}) size {tex.width}x{tex.height} exceeds atlas size {atlasSize}.");
                    hasErrors = true;
                }
            }

            if (hasErrors)
                return null;

            // Sort indices by area descending (FFD heuristic)
            var sortedIndices = new List<int>(textures.Count);
            for (int i = 0; i < textures.Count; i++)
                sortedIndices.Add(i);

            sortedIndices.Sort((a, b) =>
            {
                long areaA = (long)textures[a].width * textures[a].height;
                long areaB = (long)textures[b].width * textures[b].height;
                return areaB.CompareTo(areaA);
            });

            // Greedy first-fit bin packing
            var groups = new List<AtlasGroup>();

            foreach (int idx in sortedIndices)
            {
                long texArea = (long)textures[idx].width * textures[idx].height;
                AtlasGroup target = null;

                for (int g = 0; g < groups.Count; g++)
                {
                    if (groups[g].UsedArea + texArea <= atlasArea)
                    {
                        target = groups[g];
                        break;
                    }
                }

                if (target == null)
                {
                    target = new AtlasGroup();
                    groups.Add(target);
                }

                target.Indices.Add(idx);
                target.UsedArea += texArea;
            }

            if (maxAtlases >= 0 && groups.Count > maxAtlases)
            {
                Debug.LogError($"[TextureAtlasPlanner] Packing requires {groups.Count} atlases, max is {maxAtlases}.");
                return null;
            }

            var result = new int[groups.Count][];
            for (int g = 0; g < groups.Count; g++)
            {
                result[g] = groups[g].Indices.ToArray();
                long usedKB = groups[g].UsedArea / 1024;
                long atlasKB = (long)atlasSize * atlasSize / 1024;
                Debug.Log($"[TextureAtlas] Planner group {g}: {result[g].Length} texture(s), area used {usedKB}/{atlasKB} KB ({(float)groups[g].UsedArea / ((long)atlasSize * atlasSize) * 100f:F1}%)");
            }

            return new TextureAtlasAssignment { AtlasSize = atlasSize, Groups = result };
        }
    }
}
