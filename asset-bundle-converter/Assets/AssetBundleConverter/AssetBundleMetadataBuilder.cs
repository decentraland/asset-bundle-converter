using AssetBundleConverter.Wrappers.Interfaces;
using System.Collections.Generic;
using System.Linq;
using System.Runtime.CompilerServices;
using UnityEngine;

[assembly: InternalsVisibleTo("AssetBundleBuilderEditorTests")]

namespace DCL.ABConverter
{
    public static class AssetBundleMetadataBuilder
    {
        public const long DETERMINISTIC_TIMESTAMP = 0L;

        public static void GenerateLODMetadata(string path, string[] dependencies,
            string mainAsset, string lodName)
        {
            var metadata = new AssetBundleMetadata { timestamp = DETERMINISTIC_TIMESTAMP, mainAsset = mainAsset, dependencies = dependencies};
            string json = JsonUtility.ToJson(metadata);
            System.IO.File.WriteAllText(path + $"/{lodName}/metadata.json", json);
        }


        /// <summary>
        /// Creates the asset bundle metadata file (dependencies, version, timestamp)
        /// </summary>
        public static void Generate(IFile file, string path, Dictionary<string, string> bundleNameToHash,
            IAssetBundleManifest manifest, string version = "1.0")
        {
            string[] assetBundles = manifest.GetAllAssetBundles();

            for (int i = 0; i < assetBundles.Length; i++)
            {
                if (string.IsNullOrEmpty(assetBundles[i]))
                    continue;

                var metadata = new AssetBundleMetadata { version = version, timestamp = DETERMINISTIC_TIMESTAMP };
                string[] deps = manifest.GetAllDependencies(assetBundles[i]);

                if (deps.Length > 0)
                {
                    metadata.dependencies = deps
                        .Where(s => !s.Contains("_IGNORE") && bundleNameToHash.ContainsKey(s))
                        .ToArray();
                }

                string json = JsonUtility.ToJson(metadata);

                if (bundleNameToHash.TryGetValue(assetBundles[i], out string assetHashName)
                    && !string.IsNullOrEmpty(assetHashName))
                {
                    file.WriteAllText(path + $"/{assetHashName}/metadata.json", json);
                }
            }
        }
    }
}
