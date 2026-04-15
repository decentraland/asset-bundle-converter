using AssetBundleConverter.Wrappers.Interfaces;
using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using UnityEditor;
using UnityEditor.Build.Content;
using UnityEditor.Build.Pipeline;
using UnityEditor.Build.Pipeline.Interfaces;
using UnityEditor.SceneManagement;
using UnityEngine.Build.Pipeline;
using BuildCompression = UnityEngine.BuildCompression;

namespace DCL
{
    public class ScriptableBuildPipeline : IBuildPipeline
    {
        private class Manifest : IAssetBundleManifest
        {
            private readonly string[] allAssetBundles;
            private readonly IReadOnlyDictionary<string, BundleDetails> results;

            public Manifest(IReadOnlyDictionary<string, BundleDetails> results)
            {
                allAssetBundles = results.Keys.ToArray();
                this.results = results;
            }

            public string[] GetAllAssetBundles() =>
                allAssetBundles;

            public string[] GetAllDependencies(string assetBundle) =>
                results.TryGetValue(assetBundle, out var bundleDetails) ? bundleDetails.Dependencies : Array.Empty<string>();
        }

        public IAssetBundleManifest BuildAssetBundles(string outputPath, BuildAssetBundleOptions options, BuildTarget targetPlatform)
        {
            // It's a must to save (or discard) dirty scenes before building asset bundles, otherwise the build will fail.
            EditorSceneManager.SaveOpenScenes();

            var buildInput = ContentBuildInterface.GenerateAssetBundleBuilds();
            // Address by file names instead of full paths for backwards compatibility.
            // Fall back to the full path for any asset whose file name is not unique within its bundle —
            // SBP rejects duplicate internal ids since package 2.4.3.
            for (var i = 0; i < buildInput.Length; i++)
            {
                var assetNames = buildInput[i].assetNames;
                var shortNames = assetNames.Select(Path.GetFileName).ToArray();

                var duplicatedNames = shortNames
                    .GroupBy(n => n, StringComparer.OrdinalIgnoreCase)
                    .Where(g => g.Count() > 1)
                    .Select(g => g.Key)
                    .ToHashSet(StringComparer.OrdinalIgnoreCase);

                buildInput[i].addressableNames = assetNames
                    .Select((path, idx) => duplicatedNames.Contains(shortNames[idx]) ? path : shortNames[idx])
                    .ToArray();
            }

            var group = BuildPipeline.GetBuildTargetGroup(targetPlatform);
            var parameters = new BundleBuildParameters(targetPlatform, group, outputPath);

            // Forcing rebuilt is redundant as SBP respects individual asset changes.
            //if ((options & BuildAssetBundleOptions.ForceRebuildAssetBundle) != 0)
            //    parameters.UseCache = false;

            if ((options & BuildAssetBundleOptions.AppendHashToAssetBundleName) != 0)
                parameters.AppendHash = true;

            if ((options & BuildAssetBundleOptions.ChunkBasedCompression) != 0)
                parameters.BundleCompression = BuildCompression.LZ4;
            else if ((options & BuildAssetBundleOptions.UncompressedAssetBundle) != 0)
                parameters.BundleCompression = BuildCompression.Uncompressed;
            else
                parameters.BundleCompression = BuildCompression.LZMA;

            parameters.DisableVisibleSubAssetRepresentations = true;

            IBundleBuildResults results;
            ReturnCode exitCode = ContentPipeline.BuildAssetBundles(parameters, new BundleBuildContent(buildInput), out results);

            if (exitCode < ReturnCode.Success)
                throw new Exception($"Scriptable Build Pipeline failed with code {exitCode}");

            return new Manifest(results.BundleInfos);
        }
    }
}
