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
            // Address by names instead of paths for backwards compatibility.
            for (var i = 0; i < buildInput.Length; i++)
                buildInput[i].addressableNames = buildInput[i].assetNames.Select(Path.GetFileName).ToArray();

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
