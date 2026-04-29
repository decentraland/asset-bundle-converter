using AssetBundleConverter.Wrappers.Interfaces;
using System;
using System.Collections.Generic;
using System.Linq;
using System.Runtime.CompilerServices;
using UnityEngine;

[assembly: InternalsVisibleTo("AssetBundleBuilderEditorTests")]

namespace DCL.ABConverter
{
    public static class AssetBundleMetadataBuilder
    {
        public static void GenerateLODMetadata(string path, string[] dependencies, 
            string mainAsset, string lodName)
        {
            var metadata = new AssetBundleMetadata { timestamp = DateTime.UtcNow.Ticks, mainAsset = mainAsset, dependencies = dependencies};
            string json = JsonUtility.ToJson(metadata);
            System.IO.File.WriteAllText(path + $"/{lodName}/metadata.json", json); 
        }
        
        
        /// <summary>
        /// Creates the asset bundle metadata file (dependencies, version, timestamp)
        /// </summary>
        public static void Generate(IFile file, string path, Dictionary<string, string> hashLowercaseToHashProper, IAssetBundleManifest manifest, string version = "1.0")
        {
            string[] assetBundles = manifest.GetAllAssetBundles();

            for (int i = 0; i < assetBundles.Length; i++)
            {
                if (string.IsNullOrEmpty(assetBundles[i]))
                    continue;

                var metadata = new AssetBundleMetadata { version = version, timestamp = DateTime.UtcNow.Ticks };
                string[] deps = manifest.GetAllDependencies(assetBundles[i]);

                if (deps.Length > 0)
                {
                    deps = deps.Where(s => !s.Contains("_IGNORE")).ToArray();

                    metadata.dependencies = deps.Select(x =>
                                                 {
                                                     if (hashLowercaseToHashProper.TryGetValue(x, out string expression))
                                                         return expression;

                                                     return x;
                                                 })
                                                .ToArray();
                }

                string json = JsonUtility.ToJson(metadata);

                // Composite glb/gltf bundle names are `{hash}_{digest}_{platform}`; legacy /
                // texture / buffer bundle names are `{hash}_{platform}`. After stripping the
                // trailing platform suffix the leading underscore-delimited segment is always
                // the raw asset hash — regardless of whether a per-glb digest is present —
                // so we slice on the first `_` before looking up the proper-cased hash.
                // Without this, composite-named bundles silently fail the dictionary lookup
                // (the `out` overwrites `assetHashName` with `null` on miss), no metadata.json
                // ever gets written into the asset folder, and the second BuildAssetBundles
                // pass produces glb bundles with no embedded dependency info — at runtime the
                // explorer treats them as having zero dependencies, never loads texture
                // bundles, and renders white materials.
                string withoutPlatform = PlatformUtils.RemovePlatform(assetBundles[i]);
                int firstUnderscore = withoutPlatform.IndexOf('_');
                string lookupKey = firstUnderscore > 0 ? withoutPlatform.Substring(0, firstUnderscore) : withoutPlatform;

                if (hashLowercaseToHashProper.TryGetValue(lookupKey, out string assetHashName) && !string.IsNullOrEmpty(assetHashName))
                {
                    file.WriteAllText(path + $"/{assetHashName}/metadata.json", json);
                }
            }
        }
    }
}
