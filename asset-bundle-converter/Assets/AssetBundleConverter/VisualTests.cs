using AssetBundleConverter;
using AssetBundleConverter.Wrappers.Interfaces;
using DCL.Helpers;
using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Threading.Tasks;
using UnityEditor;
using UnityEditor.SceneManagement;
using UnityEngine;
using UnityEngine.Networking;
using UnityEngine.SceneManagement;
using Environment = AssetBundleConverter.Environment;
using Object = UnityEngine.Object;

namespace DCL.ABConverter
{
    public static class VisualTests
    {
        private static readonly string BASELINE_IMAGES_PATH = AssetBundlesVisualTestUtils.baselineImagesPath;
        private static readonly string TEST_IMAGES_PATH = AssetBundlesVisualTestUtils.testImagesPath;
        private static readonly string SCENE_NAME = "Assets/AssetBundleConverter/VisualTestScene.unity";

        private static string abPath = Application.dataPath + "/../AssetBundles/";
        private static int skippedAssets;

        /// <summary>
        ///     Instantiate all locally-converted GLTFs in both formats (GLTF and Asset Bundle) and
        ///     compare them visually. If a visual test fails, the AB is deleted to avoid uploading it
        /// </summary>
        public static async Task TestConvertedAssetsAsync(Environment env, ClientSettings clientSettings, List<AssetPath> assetsToMark, IErrorReporter errorReporter)
        {
            if (Utils.ParseOption(Config.CLI_SET_CUSTOM_OUTPUT_ROOT_PATH, 1, out string[] outputPath))
            {
                abPath = Path.Combine(Directory.GetCurrentDirectory(), outputPath[0] + "/");

                Debug.Log($"Visual Test Detection: -output PATH param found, setting ABPath as '{abPath}'");
            }
            else
                Debug.Log($"Visual Test Detection: -output PATH param NOT found, setting ABPath as '{abPath}'");

            if (!Directory.Exists(abPath))
            {
                Debug.Log($"Visual Test Detection: ABs path '{abPath}' doesn't exist...");
                SkipAllAssets();
                return;
            }

            Debug.Log("Visual Test Detection: Starting converted assets testing...");

            Scene scene = EditorSceneManager.OpenScene(SCENE_NAME, OpenSceneMode.Single);
            await WaitUntil(() => scene.isLoaded);

            // Update visual tests path that will be used internally for the snapshots
            AssetBundlesVisualTestUtils.baselineImagesPath += "ABConverter/";
            AssetBundlesVisualTestUtils.testImagesPath += "ABConverter/";
            skippedAssets = 0;

            GameObject[] gltfs = LoadAndInstantiateAllGltfAssets(clientSettings, assetsToMark);

            if (gltfs.Length == 0)
            {
                Debug.Log("Visual Test Detection: no instantiated GLTFs...");
                SkipAllAssets();
                return;
            }

            // Take prewarm snapshot to make sure the scene is correctly loaded
            await TakeObjectSnapshot(new GameObject(), "ABConverter_Warmup.png");

            AssetBundlesVisualTestUtils.generateBaseline = true;

            foreach (GameObject go in gltfs)
                go.SetActive(false);

            foreach (GameObject go in gltfs)
            {
                go.SetActive(true);

                await TakeObjectSnapshot(go, $"ABConverter_{go.name}.png");

                go.SetActive(false);
            }

            AssetBundlesVisualTestUtils.generateBaseline = false;

            GameObject[] abs = LoadAndInstantiateAllAssetBundles(clientSettings);

            if (abs.Length == 0)
            {
                Debug.Log("Visual Test Detection: no instantiated ABs...");
                SkipAllAssets();
                return;
            }

            foreach (GameObject go in abs)
            {
                Renderer[] renderers = go.GetComponentsInChildren<Renderer>(true);

                foreach (Renderer renderer in renderers)
                    if (renderer.name.ToLower().Contains("_collider"))
                        renderer.enabled = false;

                go.SetActive(false);
            }

            foreach (GameObject go in abs)
            {
                var testName = $"ABConverter_{go.name}.png";

                go.SetActive(true);

                await TakeObjectSnapshot(go, testName);

                float result = AssetBundlesVisualTestUtils.TestSnapshot(
                    AssetBundlesVisualTestUtils.baselineImagesPath + testName,
                    AssetBundlesVisualTestUtils.testImagesPath + testName);

                bool isValid = result >= 95;

                // Delete failed AB files to avoid uploading them
                if (!isValid && env != null)
                {
                    string filePath = abPath + go.name;

                    if (env.file.Exists(filePath))
                    {
                        env.file.Delete(filePath);
                        env.file.Delete(filePath + ".depmap");
                    }

                    skippedAssets++;

                    string message = "Visual test failed on " + go.name + $" with {result}% affinity";
                    Debug.LogError(message, go);

                    //errorReporter.ReportError(message, clientSettings);
                }

                go.SetActive(false);
            }

            // Reset visual tests path
            AssetBundlesVisualTestUtils.baselineImagesPath = BASELINE_IMAGES_PATH;
            AssetBundlesVisualTestUtils.testImagesPath = TEST_IMAGES_PATH;

            Debug.Log("Visual Test Detection: Finished converted assets testing...skipped assets: " + skippedAssets);
        }

        public static async Task WaitUntil(Func<bool> predicate, int sleep = 50)
        {
            while (!predicate())
                await Task.Delay(sleep);
        }

        /// <summary>
        ///     Set skippedAssets to the amount of target assets
        /// </summary>
        private static void SkipAllAssets()
        {
            skippedAssets = AssetDatabase.FindAssets("t:GameObject", new[] { "Assets/_Downloaded" }).Length;
        }

        /// <summary>
        ///     Position camera based on renderer bounds and take snapshot
        /// </summary>
        private static async Task TakeObjectSnapshot(GameObject targetGO, string testName)
        {
            Vector3 originalScale = targetGO.transform.localScale;
            Renderer[] renderers = targetGO.GetComponentsInChildren<Renderer>();

            // unify all child renderer bounds and use that to position the snapshot camera
            Bounds mergedBounds = MeshUtils.BuildMergedBounds(renderers);

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

            var cameraPosition = new Vector3(mergedBounds.min.x - offset.x, mergedBounds.max.y + offset.y, mergedBounds.min.z - offset.z);

            await AssetBundlesVisualTestUtils.TakeSnapshot(testName, Camera.main, cameraPosition, mergedBounds.center);

            targetGO.transform.localScale = originalScale;
        }

        /// <summary>
        ///     Instantiate all local GLTFs found in the "_Downloaded" directory
        /// </summary>
        /// <param name="clientSettings"></param>
        /// <param name="assetsToMark"></param>
        private static GameObject[] LoadAndInstantiateAllGltfAssets(ClientSettings clientSettings, List<AssetPath> assetsToMark)
        {
            var importedGltFs = new List<GameObject>();

            if (!string.IsNullOrEmpty(clientSettings.importOnlyEntity))
                importedGltFs.Add(ImportSingleGltfFromPath(clientSettings, assetsToMark));
            else
                importedGltFs.AddRange(ImportGltfsFromDownloadedAssets());

            return importedGltFs.ToArray();
        }

        private static List<GameObject> ImportGltfsFromDownloadedAssets()
        {
            var importedGltFs = new List<GameObject>();
            string[] assets = AssetDatabase.FindAssets("t:GameObject", new[] { "Assets/_Downloaded" });

            foreach (string guid in assets)
            {
                GameObject gltf = AssetDatabase.LoadAssetAtPath<GameObject>(AssetDatabase.GUIDToAssetPath(guid));
                GameObject importedGltf = Object.Instantiate(gltf);
                SetupGameObjectGltf(importedGltf);
                importedGltFs.Add(importedGltf);
            }

            return importedGltFs;
        }

        private static GameObject ImportSingleGltfFromPath(ClientSettings clientSettings, List<AssetPath> AssetsToMark)
        {
            AssetPath assetPath = AssetsToMark.First(p =>
                string.Equals(p.hash, clientSettings.importOnlyEntity, StringComparison.CurrentCultureIgnoreCase));

            string path = assetPath.finalPath;
            string relativePathTo = PathUtils.GetRelativePathTo(Application.dataPath, path);

            GameObject gltf = AssetDatabase.LoadAssetAtPath<GameObject>(relativePathTo);
            GameObject importedGltf = Object.Instantiate(gltf);
            SetupGameObjectGltf(importedGltf);

            return importedGltf;
        }

        private static void SetupGameObjectGltf(GameObject importedGLTF)
        {
            importedGLTF.name = importedGLTF.name.Replace("(Clone)", "");

            PatchSkeletonlessSkinnedMeshRenderer(importedGLTF.gameObject.GetComponentInChildren<SkinnedMeshRenderer>());

            Renderer[] renderers = importedGLTF.GetComponentsInChildren<Renderer>(true);

            foreach (Renderer renderer in renderers)
                if (renderer.name.ToLower().Contains("_collider"))
                    renderer.enabled = false;
        }

        /// <summary>
        ///     Search for local GLTFs in "_Downloaded" and use those hashes to find their corresponding
        ///     Asset Bundle files, then instantiate those ABs in the Unity scene
        /// </summary>
        /// <param name="ClientSettings"></param>
        public static GameObject[] LoadAndInstantiateAllAssetBundles(ClientSettings ClientSettings)
        {
            Caching.ClearCache();

            var workingFolderName = "_Downloaded";

            string[] pathList = Directory.GetDirectories(Application.dataPath + "/" + workingFolderName);

            var dependencyAbs = new List<string>();
            var mainAbs = new List<string>();

            foreach (string paths in pathList)
            {
                string hash = new DirectoryInfo(paths).Name;
                string path = "Assets/" + workingFolderName + "/" + hash;
                string[] guids = AssetDatabase.FindAssets("t:GameObject", new[] { path });

                // NOTE(Brian): If no gameObjects are found, we assume they are dependency assets (textures, etc).
                if (guids.Length == 0)
                {
                    // We need to avoid adding dependencies that are NOT converted to ABs (like .bin files)
                    if (AssetDatabase.FindAssets("t:Texture", new[] { path }).Length != 0)
                        dependencyAbs.Add(hash);
                }
                else

                    // Otherwise we assume they are gltfs.
                    mainAbs.Add(hash);
            }

            // NOTE(Brian): We need to store the asset bundles so they can be unloaded later.
            var loadedAbs = new List<AssetBundle>();

            foreach (string hash in dependencyAbs)
            {
                string path = abPath + hash;
                UnityWebRequest req = UnityWebRequestAssetBundle.GetAssetBundle(path);

                if (SystemInfo.operatingSystemFamily == OperatingSystemFamily.MacOSX || SystemInfo.operatingSystemFamily == OperatingSystemFamily.Linux)
                    req.url = req.url.Replace("http://localhost", "file:///");

                req.SendWebRequest();

                while (!req.isDone) { }

                if (!req.WebRequestSucceded())
                {
                    Debug.Log("Visual Test Detection: Failed to download dependency asset: " + hash);
                    continue;
                }

                AssetBundle assetBundle = DownloadHandlerAssetBundle.GetContent(req);
                assetBundle.LoadAllAssets();
                loadedAbs.Add(assetBundle);
            }

            var results = new List<GameObject>();

            foreach (string hash in mainAbs)
            {
                string path = abPath + hash;
                UnityWebRequest req = UnityWebRequestAssetBundle.GetAssetBundle(path);

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

                AssetBundle assetBundle = DownloadHandlerAssetBundle.GetContent(req);
                Object[] assets = assetBundle.LoadAllAssets();

                foreach (Object asset in assets)
                {
                    if (asset is Material material)
                    {
                        if (ClientSettings.shaderType == ShaderType.Dcl)
                            material.shader = Shader.Find("DCL/Scene");
                        else
                            material.shader = Shader.Find("Shader Graphs/glTF-pbrMetallicRoughness");
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

            foreach (AssetBundle ab in loadedAbs)
                ab.Unload(false);

            return results.ToArray();
        }

        /// <summary>
        ///     Wearables that are not body-shapes are optimized getting rid of the skeleton, so if this
        ///     SkinnedMeshRenderer is missing its root bone, we replace the renderer to make it rendereable
        ///     for the visual tests. In runtime, WearableController.SetAnimatorBones() takes care of the
        ///     root bone setup.
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
