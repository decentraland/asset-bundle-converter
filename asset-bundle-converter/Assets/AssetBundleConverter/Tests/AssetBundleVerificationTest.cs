using NUnit.Framework;
using System.IO;
using System.Net.Http;
using System.Threading.Tasks;
using UnityEngine;

namespace AssetBundleConverter.Tests
{
    /// <summary>
    /// Downloads Cube + albedo asset bundles for two scenes from the CDN,
    /// loads them one at a time, and verifies:
    /// - Both Cubes instantiate and have a mesh with the same vertex/triangle count
    /// - Both Cubes have different textures (different albedo.png source hashes)
    /// </summary>
    [TestFixture]
    [Category("E2EVerification")]
    public class AssetBundleVerificationTest
    {
        private const string ENTITY_1 = "bafkreie7jn6nvmgmy4dlgblwmue5zqcpd52autcengvmt2moz2mcid5ez4";
        private const string ENTITY_2 = "bafkreid66pd52q3isartlszn3ajwfeqin43qt2r52nyeamm7uaxkbu2oly";
        private const string CUBE_HASH = "bafkreie5su6wnqzj7ppqzlbd4m2sgf3q76hkpzsfiqun5rfd54xvokepcm";
        private const string ALBEDO_HASH_S1 = "bafkreigy4f55gqd5g6citumtzcefwdwdtqh5nfnwia7dnwawigqem4wlhq";
        private const string ALBEDO_HASH_S2 = "bafybeich3nzq4bym2mufrymp3bg5yy7vdts2mgixfsutv5kzt5gm2j4m7m";
        private const string CDN_BASE = "https://ab-cdn.decentraland.zone/v48";
        // Use mac bundles for local Editor testing (webgl bundles can't load in Editor).
        // CI overrides this via the e2e pipeline which builds for the current target.
        private const string TARGET = "mac";

        private static readonly string DOWNLOAD_DIR = Path.Combine(Application.temporaryCachePath, "e2e-bundles");
        private static readonly HttpClient httpClient = new HttpClient();

        private string scene1CubePath;
        private string scene1AlbedoPath;
        private string scene2CubePath;
        private string scene2AlbedoPath;

        [OneTimeSetUp]
        public async Task DownloadBundles()
        {
            Directory.CreateDirectory(DOWNLOAD_DIR);

            scene1CubePath = Path.Combine(DOWNLOAD_DIR, $"s1_cube_{TARGET}");
            scene1AlbedoPath = Path.Combine(DOWNLOAD_DIR, $"s1_albedo_{TARGET}");
            scene2CubePath = Path.Combine(DOWNLOAD_DIR, $"s2_cube_{TARGET}");
            scene2AlbedoPath = Path.Combine(DOWNLOAD_DIR, $"s2_albedo_{TARGET}");

            await DownloadBundle($"{CDN_BASE}/{ENTITY_1}/{CUBE_HASH}_{TARGET}", scene1CubePath);
            await DownloadBundle($"{CDN_BASE}/{ENTITY_1}/{ALBEDO_HASH_S1}_{TARGET}", scene1AlbedoPath);
            await DownloadBundle($"{CDN_BASE}/{ENTITY_2}/{CUBE_HASH}_{TARGET}", scene2CubePath);
            await DownloadBundle($"{CDN_BASE}/{ENTITY_2}/{ALBEDO_HASH_S2}_{TARGET}", scene2AlbedoPath);
        }

        [Test]
        public void BothCubes_ShouldLoadWithSameMeshButDifferentTextures()
        {
            // --- Scene 1 ---
            var albedo1 = AssetBundle.LoadFromFile(scene1AlbedoPath);
            Assert.IsNotNull(albedo1, "Failed to load Scene 1 albedo bundle");

            var cube1 = AssetBundle.LoadFromFile(scene1CubePath);
            Assert.IsNotNull(cube1, "Failed to load Scene 1 Cube bundle");

            var instance1 = InstantiatePrefab(cube1, "Scene 1");
            var mesh1 = instance1.GetComponentInChildren<MeshFilter>()?.sharedMesh;
            Assert.IsNotNull(mesh1, "Scene 1 Cube has no mesh");
            int vertexCount = mesh1.vertexCount;
            int triangleCount = mesh1.triangles.Length;

            var tex1 = GetAlbedoTexture(instance1, "Scene 1");
            Assert.IsNotNull(tex1, "Scene 1 Cube has no albedo texture");
            var texHash1 = Hash128.Compute(tex1.GetRawTextureData());

            Object.DestroyImmediate(instance1);
            cube1.Unload(true);
            albedo1.Unload(true);

            // --- Scene 2 ---
            var albedo2 = AssetBundle.LoadFromFile(scene2AlbedoPath);
            Assert.IsNotNull(albedo2, "Failed to load Scene 2 albedo bundle");

            var cube2 = AssetBundle.LoadFromFile(scene2CubePath);
            Assert.IsNotNull(cube2, "Failed to load Scene 2 Cube bundle");

            var instance2 = InstantiatePrefab(cube2, "Scene 2");
            var mesh2 = instance2.GetComponentInChildren<MeshFilter>()?.sharedMesh;
            Assert.IsNotNull(mesh2, "Scene 2 Cube has no mesh");

            Assert.AreEqual(vertexCount, mesh2.vertexCount,
                "Cubes should have the same vertex count (same Cube.gltf source)");
            Assert.AreEqual(triangleCount, mesh2.triangles.Length,
                "Cubes should have the same triangle count (same Cube.gltf source)");

            var tex2 = GetAlbedoTexture(instance2, "Scene 2");
            Assert.IsNotNull(tex2, "Scene 2 Cube has no albedo texture");
            var texHash2 = Hash128.Compute(tex2.GetRawTextureData());

            Assert.AreNotEqual(texHash1, texHash2,
                "Cube textures should differ between scenes (different albedo.png hashes)");

            Object.DestroyImmediate(instance2);
            cube2.Unload(true);
            albedo2.Unload(true);
        }

        private static GameObject InstantiatePrefab(AssetBundle bundle, string label)
        {
            var assetNames = bundle.GetAllAssetNames();
            Assert.IsTrue(assetNames.Length > 0, $"{label} Cube bundle has no assets");

            // Log all assets and their types for debugging
            foreach (var name in assetNames)
            {
                var allAtPath = bundle.LoadAsset(name);
                Debug.Log($"{label} bundle asset: '{name}' type={allAtPath?.GetType().Name ?? "null"}");
            }

            // Try loading as GameObject first, then try all assets
            GameObject prefab = null;
            foreach (var name in assetNames)
            {
                prefab = bundle.LoadAsset<GameObject>(name);
                if (prefab != null) break;
            }

            if (prefab == null)
            {
                // Try loading all objects and find a GameObject
                var allObjects = bundle.LoadAllAssets<GameObject>();
                if (allObjects.Length > 0) prefab = allObjects[0];
            }

            Assert.IsNotNull(prefab, $"{label} Cube bundle contains no GameObject. Assets: [{string.Join(", ", assetNames)}]");

            return Object.Instantiate(prefab);
        }

        private static Texture2D GetAlbedoTexture(GameObject instance, string label)
        {
            var renderer = instance.GetComponentInChildren<Renderer>();
            Assert.IsNotNull(renderer, $"{label} Cube has no Renderer");

            var material = renderer.sharedMaterial;
            Assert.IsNotNull(material, $"{label} Cube Renderer has no material");

            Texture tex = material.mainTexture;
            if (tex == null) tex = material.GetTexture("_BaseMap");
            if (tex == null) tex = material.GetTexture("_MainTex");

            return tex as Texture2D;
        }

        private static async Task DownloadBundle(string url, string destPath)
        {
            if (File.Exists(destPath))
            {
                Debug.Log($"Bundle already cached: {destPath}");
                return;
            }

            Debug.Log($"Downloading bundle: {url}");
            var bytes = await httpClient.GetByteArrayAsync(url);
            await File.WriteAllBytesAsync(destPath, bytes);

            Assert.Greater(bytes.Length, 0, $"Downloaded file is empty from {url}");
            Debug.Log($"Downloaded bundle to {destPath} ({bytes.Length} bytes)");
        }
    }
}
