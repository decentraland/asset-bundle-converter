using System.Collections.Generic;
using UnityEngine;

namespace AssetBundleConverter.TextureAtlas
{
    public class TextureDeduplicationResult
    {
        /// <summary>One canonical Texture2D per unique content group.</summary>
        public List<Texture2D> UniqueTextures;

        /// <summary>
        /// For each index i in the original list, CanonicalIndices[i] is the index into
        /// UniqueTextures that represents it.  Textures that are already canonical map to
        /// themselves; duplicates map to the index of the texture they duplicate.
        /// </summary>
        public int[] CanonicalIndices;

        /// <summary>Number of duplicate textures that were collapsed.</summary>
        public int DuplicateCount => CanonicalIndices.Length - UniqueTextures.Count;
    }

    /// <summary>
    /// Detects Texture2D objects that have identical pixel content and groups them so that
    /// only one canonical texture per group needs to be processed downstream.
    ///
    /// Uses <see cref="Texture2D.imageContentsHash"/> (a Unity-managed Hash128) as the
    /// content fingerprint — no CPU pixel readback required.  Textures whose hash is the
    /// zero default (runtime-created, not imported from disk) are always treated as unique.
    /// </summary>
    public static class TextureDuplicateResolver
    {
        public static TextureDeduplicationResult Resolve(IList<Texture2D> textures)
        {
            Debug.Log($"[TextureAtlas] TextureDuplicateResolver.Resolve: checking {textures.Count} texture(s) for duplicates.");
            var uniqueTextures = new List<Texture2D>(textures.Count);
            var canonicalIndices = new int[textures.Count];

            // key: (width, height, Hash128) → index in uniqueTextures
            var seen = new Dictionary<(int, int, Hash128), int>(textures.Count);

            for (int i = 0; i < textures.Count; i++)
            {
                var tex = textures[i];

                if (tex == null)
                {
                    // Preserve nulls; Plan() will validate and report them
                    canonicalIndices[i] = uniqueTextures.Count;
                    uniqueTextures.Add(null);
                    continue;
                }

                var hash = tex.imageContentsHash;

                // Zero hash means the texture has no stable content fingerprint (e.g. created
                // at runtime). Fall through to treat it as unique.
                if (hash != default(Hash128))
                {
                    var key = (tex.width, tex.height, hash);

                    if (seen.TryGetValue(key, out int existingIdx))
                    {
                        canonicalIndices[i] = existingIdx;
                        Debug.Log($"[TextureDuplicateResolver] '{tex.name}' is a duplicate of '{uniqueTextures[existingIdx].name}' — will use canonical.");
                        continue;
                    }

                    seen[key] = uniqueTextures.Count;
                }

                canonicalIndices[i] = uniqueTextures.Count;
                uniqueTextures.Add(tex);
            }

            int duplicateCount = canonicalIndices.Length - uniqueTextures.Count;
            Debug.Log($"[TextureAtlas] TextureDuplicateResolver: {uniqueTextures.Count} unique, {duplicateCount} duplicate(s).");

            return new TextureDeduplicationResult
            {
                UniqueTextures = uniqueTextures,
                CanonicalIndices = canonicalIndices
            };
        }
    }
}
