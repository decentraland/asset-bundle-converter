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
        /// Creates the asset bundle metadata file (dependencies, version, timestamp).
        /// The manifest reports Unity's lowercased bundle names, so every name is re-cased through
        /// <paramref name="lowerCaseHashes"/> (lowercase hash → original-case hash) before being used:
        /// the bundle lookup key in <paramref name="bundleNameToHash"/> and the written dependency
        /// entries must both carry the original casing — dependency names are fetched verbatim by
        /// clients from the case-sensitive CDN, where files are stored under the original-case name.
        /// </summary>
        public static void Generate(IFile file, string path, Dictionary<string, string> bundleNameToHash,
            Dictionary<string, string> lowerCaseHashes, IAssetBundleManifest manifest, string version = "1.0")
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
                    metadata.dependencies = deps
                        .Where(s => !s.Contains("_IGNORE"))
                        .Select(s => Utils.GetCanonicalBundleFileName(s, lowerCaseHashes))
                        .Where(s => bundleNameToHash.ContainsKey(s))
                        .ToArray();
                }

                string json = JsonUtility.ToJson(metadata);

                if (bundleNameToHash.TryGetValue(Utils.GetCanonicalBundleFileName(assetBundles[i], lowerCaseHashes), out string assetHashName)
                    && !string.IsNullOrEmpty(assetHashName))
                {
                    file.WriteAllText(path + $"/{assetHashName}/metadata.json", json);
                }
            }
        }
    }
}
