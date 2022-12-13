using AssetBundleConverter;
using System.Collections;
using System.Collections.Generic;
using System.IO;
using System;
using System.Threading.Tasks;
using DCL.Helpers;
using System.Linq;
using UnityEditor;
using UnityEditor.SceneManagement;
using UnityEngine;
using UnityEngine.Networking;
using Object = UnityEngine.Object;

namespace DCL.ABConverter
{
    public static class VisualTests
    {
        static readonly string BASELINE_IMAGES_PATH = AssetBundlesVisualTestUtils.baselineImagesPath;
        static readonly string TEST_IMAGES_PATH = AssetBundlesVisualTestUtils.testImagesPath;
        static readonly string SCENE_NAME = "Assets/AssetBundleConverter/VisualTestScene.unity";

        static string abPath = Application.dataPath + "/../AssetBundles/";
        static int skippedAssets = 0;

        /// <summary>
        /// Instantiate all locally-converted GLTFs in both formats (GLTF and Asset Bundle) and
        /// compare them visually. If a visual test fails, the AB is deleted to avoid uploading it
        /// </summary>
        public static async Task<bool> TestConvertedAssets(Environment env, ClientSettings clientSettings, List<AssetPath> assetsToMark, Action<int> OnFinish = null)
        {
            if (Utils.ParseOption(Config.CLI_SET_CUSTOM_OUTPUT_ROOT_PATH, 1, out string[] outputPath))
            {
                abPath = System.IO.Path.Combine(Directory.GetCurrentDirectory(), outputPath[0] + "/");

                Debug.Log($"Visual Test Detection: -output PATH param found, setting ABPath as '{abPath}'");
            }
            else { Debug.Log($"Visual Test Detection: -output PATH param NOT found, setting ABPath as '{abPath}'"); }

            if (!System.IO.Directory.Exists(abPath))
            {
                Debug.Log($"Visual Test Detection: ABs path '{abPath}' doesn't exist...");
                SkipAllAssets();
                OnFinish?.Invoke(skippedAssets);

                return false;
            }

            Debug.Log("Visual Test Detection: Starting converted assets testing...");

            var scene = EditorSceneManager.OpenScene(SCENE_NAME, OpenSceneMode.Single);
            await WaitUntil(() => scene.isLoaded);

            // Update visual tests path that will be used internally for the snapshots
            AssetBundlesVisualTestUtils.baselineImagesPath += "ABConverter/";
            AssetBundlesVisualTestUtils.testImagesPath += "ABConverter/";
            skippedAssets = 0;

            var gltfs = LoadAndInstantiateAllGltfAssets(clientSettings, assetsToMark);

            if (gltfs.Length == 0)
            {
                Debug.Log("Visual Test Detection: no instantiated GLTFs...");
                SkipAllAssets();
                OnFinish?.Invoke(skippedAssets);

                return false;
            }

            // Take prewarm snapshot to make sure the scene is correctly loaded
            await TakeObjectSnapshot(new GameObject(), $"ABConverter_Warmup.png");

            AssetBundlesVisualTestUtils.generateBaseline = true;

            foreach (GameObject go in gltfs) { go.SetActive(false); }

            foreach (GameObject go in gltfs)
            {
                go.SetActive(true);

                await TakeObjectSnapshot(go, $"ABConverter_{go.name}.png");

                go.SetActive(false);
            }

            AssetBundlesVisualTestUtils.generateBaseline = false;

            var abs = LoadAndInstantiateAllAssetBundles();

            if (abs.Length == 0)
            {
                Debug.Log("Visual Test Detection: no instantiated ABs...");
                SkipAllAssets();
                OnFinish?.Invoke(skippedAssets);
                return false;
            }

            foreach (GameObject go in abs)
            {
                var renderers = go.GetComponentsInChildren<Renderer>(true);

                foreach (Renderer renderer in renderers)
                {
                    if (renderer.name.ToLower().Contains("_collider")) { renderer.enabled = false; }
                }

                go.SetActive(false);
            }

            foreach (GameObject go in abs)
            {
                string testName = $"ABConverter_{go.name}.png";

                go.SetActive(true);

                await TakeObjectSnapshot(go, testName);

                bool result = AssetBundlesVisualTestUtils.TestSnapshot(
                    AssetBundlesVisualTestUtils.baselineImagesPath + testName,
                    AssetBundlesVisualTestUtils.testImagesPath + testName,
                    95,
                    false);

                // Delete failed AB files to avoid uploading them
                if (!result && env != null)
                {
                    string filePath = abPath + go.name;

                    if (env.file.Exists(filePath))
                    {
                        env.file.Delete(filePath);
                        env.file.Delete(filePath + ".depmap");
                    }

                    skippedAssets++;

                    // TODO: Notify some metrics API or something to let us know that this asset has conversion problems so that we take a look manually
                    Debug.Log("Visual Test Detection: FAILED converting asset -> " + go.name);
                }

                go.SetActive(false);
            }

            // Reset visual tests path
            AssetBundlesVisualTestUtils.baselineImagesPath = BASELINE_IMAGES_PATH;
            AssetBundlesVisualTestUtils.testImagesPath = TEST_IMAGES_PATH;

            Debug.Log("Visual Test Detection: Finished converted assets testing...skipped assets: " + skippedAssets);
            OnFinish?.Invoke(skippedAssets);

            return skippedAssets <= 0;
        }

        public static async Task WaitUntil(Func<bool> predicate, int sleep = 50)
        {
            while (!predicate()) { await Task.Delay(sleep); }
        }

        /// <summary>
        /// Set skippedAssets to the amount of target assets
        /// </summary>
        private static void SkipAllAssets()
        {
            skippedAssets = AssetDatabase.FindAssets($"t:GameObject", new[] { "Assets/_Downloaded" }).Length;
        }

        /// <summary>
        /// Position camera based on renderer bounds and take snapshot
        /// </summary>
        private static async Task TakeObjectSnapshot(GameObject targetGO, string testName)
        {
            Vector3 originalScale = targetGO.transform.localScale;
            var renderers = targetGO.GetComponentsInChildren<Renderer>();

            // unify all child renderer bounds and use that to position the snapshot camera
            var mergedBounds = MeshUtils.BuildMergedBounds(renderers);

            // Some objects are imported super small (like 0.00x in scale) and we can barely see them in the snapshots
            if (mergedBounds.size.magnitude < 1f)
            {
                targetGO.transform.localScale *= 100;
                mergedBounds = MeshUtils.BuildMergedBounds(renderers);
            }

            Vector3 offset = mergedBounds.extents;
            offset.x = Mathf.Max(1, offset.x);
            offset.y = Mathf.Max(1, offset.y);
            offset.z = Mathf.Max(1, offset.z);

            Vector3 cameraPosition = new Vector3(mergedBounds.min.x - offset.x, mergedBounds.max.y + offset.y, mergedBounds.min.z - offset.z);

            await AssetBundlesVisualTestUtils.TakeSnapshot(testName, Camera.main, cameraPosition, mergedBounds.center);

            targetGO.transform.localScale = originalScale;
        }

        /// <summary>
        /// Instantiate all local GLTFs found in the "_Downloaded" directory
        /// </summary>
        /// <param name="clientSettings"></param>
        /// <param name="assetsToMark"></param>
        private static GameObject[] LoadAndInstantiateAllGltfAssets(ClientSettings clientSettings, List<AssetPath> assetsToMark)
        {
            List<GameObject> importedGltFs = new List<GameObject>();

            if (!string.IsNullOrEmpty(clientSettings.importOnlyEntity))
                importedGltFs.Add(ImportSingleGltfFromPath(clientSettings, assetsToMark));
            else
                importedGltFs.AddRange(ImportGltfsFromDownloadedAssets());

            return importedGltFs.ToArray();
        }

        private static List<GameObject> ImportGltfsFromDownloadedAssets()
        {
            List<GameObject> importedGltFs = new List<GameObject>();
            string[] assets = AssetDatabase.FindAssets($"t:GameObject", new[] { "Assets/_Downloaded" });

            foreach (string guid in assets)
            {
                GameObject gltf = AssetDatabase.LoadAssetAtPath<GameObject>(AssetDatabase.GUIDToAssetPath(guid));
                var importedGltf = Object.Instantiate(gltf);
                SetupGameObjectGltf(importedGltf);
                importedGltFs.Add(importedGltf);
            }

            return importedGltFs;
        }

        private static GameObject ImportSingleGltfFromPath(ClientSettings clientSettings, List<AssetPath> AssetsToMark)
        {
            var assetPath = AssetsToMark.First(p =>
                string.Equals(p.hash, clientSettings.importOnlyEntity, StringComparison.CurrentCultureIgnoreCase));

            var path = assetPath.finalPath;
            string relativePathTo = PathUtils.GetRelativePathTo(Application.dataPath, path);

            GameObject gltf = AssetDatabase.LoadAssetAtPath<GameObject>(relativePathTo);
            var importedGltf = Object.Instantiate(gltf);
            SetupGameObjectGltf(importedGltf);

            return importedGltf;
        }

        private static void SetupGameObjectGltf(GameObject importedGLTF)
        {
            importedGLTF.name = importedGLTF.name.Replace("(Clone)", "");

            PatchSkeletonlessSkinnedMeshRenderer(importedGLTF.gameObject.GetComponentInChildren<SkinnedMeshRenderer>());

            var renderers = importedGLTF.GetComponentsInChildren<Renderer>(true);

            foreach (Renderer renderer in renderers)
                if (renderer.name.ToLower().Contains("_collider"))
                    renderer.enabled = false;
        }

        /// <summary>
        /// Search for local GLTFs in "_Downloaded" and use those hashes to find their corresponding
        /// Asset Bundle files, then instantiate those ABs in the Unity scene
        /// </summary>
        public static GameObject[] LoadAndInstantiateAllAssetBundles()
        {
            Caching.ClearCache();

            string workingFolderName = "_Downloaded";

            var pathList = Directory.GetDirectories(Application.dataPath + "/" + workingFolderName);

            List<string> dependencyAbs = new List<string>();
            List<string> mainAbs = new List<string>();

            foreach (var paths in pathList)
            {
                var hash = new DirectoryInfo(paths).Name;
                var path = "Assets/" + workingFolderName + "/" + hash;
                var guids = AssetDatabase.FindAssets("t:GameObject", new[] { path });

                // NOTE(Brian): If no gameObjects are found, we assume they are dependency assets (textures, etc).
                if (guids.Length == 0)
                {
                    // We need to avoid adding dependencies that are NOT converted to ABs (like .bin files)
                    if (AssetDatabase.FindAssets("t:Texture", new[] { path }).Length != 0) { dependencyAbs.Add(hash); }
                }
                else
                {
                    // Otherwise we assume they are gltfs.
                    mainAbs.Add(hash);
                }
            }

            // NOTE(Brian): We need to store the asset bundles so they can be unloaded later.
            List<AssetBundle> loadedAbs = new List<AssetBundle>();

            foreach (var hash in dependencyAbs)
            {
                string path = abPath + hash;
                var req = UnityWebRequestAssetBundle.GetAssetBundle(path);

                if (SystemInfo.operatingSystemFamily == OperatingSystemFamily.MacOSX || SystemInfo.operatingSystemFamily == OperatingSystemFamily.Linux)
                    req.url = req.url.Replace("http://localhost", "file:///");

                req.SendWebRequest();

                while (!req.isDone) { }

                if (!req.WebRequestSucceded())
                {
                    Debug.Log("Visual Test Detection: Failed to download dependency asset: " + hash);
                    continue;
                }

                var assetBundle = DownloadHandlerAssetBundle.GetContent(req);
                assetBundle.LoadAllAssets();
                loadedAbs.Add(assetBundle);
            }

            List<GameObject> results = new List<GameObject>();

            foreach (var hash in mainAbs)
            {
                string path = abPath + hash;
                var req = UnityWebRequestAssetBundle.GetAssetBundle(path);

                if (SystemInfo.operatingSystemFamily == OperatingSystemFamily.MacOSX || SystemInfo.operatingSystemFamily == OperatingSystemFamily.Linux)
                    req.url = req.url.Replace("http://localhost", "file:///");

                req.SendWebRequest();

                while (!req.isDone) { }

                if (!req.WebRequestSucceded())
                {
                    Debug.Log("Visual Test Detection: Failed to instantiate AB, missing source file for : " + hash);
                    skippedAssets++;
                    continue;
                }

                var assetBundle = DownloadHandlerAssetBundle.GetContent(req);
                Object[] assets = assetBundle.LoadAllAssets();

                foreach (Object asset in assets)
                {
                    if (asset is Material material)
                    {
                        material.shader = Shader.Find("DCL/Universal Render Pipeline/Lit");
                        SRPBatchingHelper.OptimizeMaterial(material);
                    }

                    if (asset is GameObject assetAsGameObject)
                    {
                        GameObject instance = Object.Instantiate(assetAsGameObject);

                        PatchSkeletonlessSkinnedMeshRenderer(instance.GetComponentInChildren<SkinnedMeshRenderer>());

                        results.Add(instance);
                        instance.name = instance.name.Replace("(Clone)", "");
                    }
                }

                loadedAbs.Add(assetBundle);
            }

            foreach (var ab in loadedAbs) { ab.Unload(false); }

            return results.ToArray();
        }

        /// <summary>
        /// Wearables that are not body-shapes are optimized getting rid of the skeleton, so if this
        /// SkinnedMeshRenderer is missing its root bone, we replace the renderer to make it rendereable
        /// for the visual tests. In runtime, WearableController.SetAnimatorBones() takes care of the
        /// root bone setup.
        /// </summary>
        private static void PatchSkeletonlessSkinnedMeshRenderer(SkinnedMeshRenderer skinnedMeshRenderer)
        {
            if (skinnedMeshRenderer == null || skinnedMeshRenderer.rootBone != null)
                return;

            MeshRenderer meshRenderer = skinnedMeshRenderer.gameObject.AddComponent<MeshRenderer>();
            meshRenderer.sharedMaterials = skinnedMeshRenderer.sharedMaterials;

            Object.DestroyImmediate(skinnedMeshRenderer);
        }
    }
}
