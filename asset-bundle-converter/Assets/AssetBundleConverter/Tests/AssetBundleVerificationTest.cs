using NUnit.Framework;
using System.IO;
using System.Linq;
using UnityEngine;

namespace AssetBundleConverter.Tests
{
    /// <summary>
    /// Loads asset bundles produced by the e2e conversion test and verifies:
    /// - Both Cube bundles load successfully (Scene 1 and Scene 2)
    /// - Both Cubes have the same mesh (same source Cube.gltf)
    /// - Both Cubes have different textures (different albedo.png per scene)
    ///
    /// Reads bundle paths from /tmp/e2e-bundle-paths.json, written by the Node
    /// e2e-conversion-test.ts script. Must run after that script completes.
    /// </summary>
    [TestFixture]
    [Category("E2EVerification")]
    public class AssetBundleVerificationTest
    {
        private const string BUNDLE_PATHS_FILE = "/tmp/e2e-bundle-paths.json";

        private BundlePaths paths;
        private AssetBundle scene1AlbedoBundle;
        private AssetBundle scene1CubeBundle;
        private AssetBundle scene2AlbedoBundle;
        private AssetBundle scene2CubeBundle;
        private GameObject scene1Instance;
        private GameObject scene2Instance;

        [System.Serializable]
        private class BundlePaths
        {
            public string scene1CubePath;
            public string scene1AlbedoPath;
            public string scene2CubePath;
            public string scene2AlbedoPath;
        }

        [SetUp]
        public void Setup()
        {
            Assert.IsTrue(File.Exists(BUNDLE_PATHS_FILE),
                $"Bundle paths file not found at {BUNDLE_PATHS_FILE}. Run e2e-conversion-test.js first.");

            var json = File.ReadAllText(BUNDLE_PATHS_FILE);
            paths = JsonUtility.FromJson<BundlePaths>(json);

            Assert.IsNotNull(paths.scene1CubePath, "scene1CubePath is null in bundle paths JSON");
            Assert.IsNotNull(paths.scene1AlbedoPath, "scene1AlbedoPath is null in bundle paths JSON");
            Assert.IsNotNull(paths.scene2CubePath, "scene2CubePath is null in bundle paths JSON");
            Assert.IsNotNull(paths.scene2AlbedoPath, "scene2AlbedoPath is null in bundle paths JSON");

            Assert.IsTrue(File.Exists(paths.scene1CubePath), $"Scene 1 Cube bundle not found: {paths.scene1CubePath}");
            Assert.IsTrue(File.Exists(paths.scene1AlbedoPath), $"Scene 1 albedo bundle not found: {paths.scene1AlbedoPath}");
            Assert.IsTrue(File.Exists(paths.scene2CubePath), $"Scene 2 Cube bundle not found: {paths.scene2CubePath}");
            Assert.IsTrue(File.Exists(paths.scene2AlbedoPath), $"Scene 2 albedo bundle not found: {paths.scene2AlbedoPath}");

            // Load texture dependencies first, then the GLB bundles
            scene1AlbedoBundle = AssetBundle.LoadFromFile(paths.scene1AlbedoPath);
            Assert.IsNotNull(scene1AlbedoBundle, $"Failed to load Scene 1 albedo bundle from {paths.scene1AlbedoPath}");

            scene1CubeBundle = AssetBundle.LoadFromFile(paths.scene1CubePath);
            Assert.IsNotNull(scene1CubeBundle, $"Failed to load Scene 1 Cube bundle from {paths.scene1CubePath}");

            scene2AlbedoBundle = AssetBundle.LoadFromFile(paths.scene2AlbedoPath);
            Assert.IsNotNull(scene2AlbedoBundle, $"Failed to load Scene 2 albedo bundle from {paths.scene2AlbedoPath}");

            scene2CubeBundle = AssetBundle.LoadFromFile(paths.scene2CubePath);
            Assert.IsNotNull(scene2CubeBundle, $"Failed to load Scene 2 Cube bundle from {paths.scene2CubePath}");
        }

        [TearDown]
        public void TearDown()
        {
            if (scene1Instance != null) Object.DestroyImmediate(scene1Instance);
            if (scene2Instance != null) Object.DestroyImmediate(scene2Instance);
            if (scene1CubeBundle != null) scene1CubeBundle.Unload(true);
            if (scene2CubeBundle != null) scene2CubeBundle.Unload(true);
            if (scene1AlbedoBundle != null) scene1AlbedoBundle.Unload(true);
            if (scene2AlbedoBundle != null) scene2AlbedoBundle.Unload(true);
        }

        [Test]
        public void BothCubes_ShouldInstantiateSuccessfully()
        {
            scene1Instance = InstantiatePrefab(scene1CubeBundle, "Scene 1");
            scene2Instance = InstantiatePrefab(scene2CubeBundle, "Scene 2");

            Assert.IsNotNull(scene1Instance, "Scene 1 Cube failed to instantiate");
            Assert.IsNotNull(scene2Instance, "Scene 2 Cube failed to instantiate");
        }

        [Test]
        public void BothCubes_ShouldHaveSameMesh()
        {
            scene1Instance = InstantiatePrefab(scene1CubeBundle, "Scene 1");
            scene2Instance = InstantiatePrefab(scene2CubeBundle, "Scene 2");

            var mesh1 = scene1Instance.GetComponentInChildren<MeshFilter>()?.sharedMesh;
            var mesh2 = scene2Instance.GetComponentInChildren<MeshFilter>()?.sharedMesh;

            Assert.IsNotNull(mesh1, "Scene 1 Cube has no MeshFilter/mesh");
            Assert.IsNotNull(mesh2, "Scene 2 Cube has no MeshFilter/mesh");

            Assert.AreEqual(mesh1.vertexCount, mesh2.vertexCount,
                "Cubes should have the same vertex count (same Cube.gltf source)");

            Assert.AreEqual(mesh1.triangles.Length, mesh2.triangles.Length,
                "Cubes should have the same triangle count (same Cube.gltf source)");
        }

        [Test]
        public void BothCubes_ShouldHaveDifferentTextures()
        {
            scene1Instance = InstantiatePrefab(scene1CubeBundle, "Scene 1");
            scene2Instance = InstantiatePrefab(scene2CubeBundle, "Scene 2");

            var tex1 = GetAlbedoTexture(scene1Instance, "Scene 1");
            var tex2 = GetAlbedoTexture(scene2Instance, "Scene 2");

            Assert.IsNotNull(tex1, "Scene 1 Cube has no albedo texture");
            Assert.IsNotNull(tex2, "Scene 2 Cube has no albedo texture");

            // Read pixel data from CPU memory — works without GPU
            var pixels1 = tex1.GetPixels32();
            var pixels2 = tex2.GetPixels32();

            Assert.IsFalse(pixels1.SequenceEqual(pixels2),
                "Cube textures should differ between scenes (different albedo.png hashes)");
        }

        private static GameObject InstantiatePrefab(AssetBundle bundle, string label)
        {
            var assetNames = bundle.GetAllAssetNames();
            Assert.IsTrue(assetNames.Length > 0, $"{label} Cube bundle has no assets");

            var prefab = bundle.LoadAsset<GameObject>(assetNames[0]);
            Assert.IsNotNull(prefab, $"{label} Cube bundle's first asset is not a GameObject");

            return Object.Instantiate(prefab);
        }

        private static Texture2D GetAlbedoTexture(GameObject instance, string label)
        {
            var renderer = instance.GetComponentInChildren<Renderer>();
            Assert.IsNotNull(renderer, $"{label} Cube has no Renderer");

            var material = renderer.sharedMaterial;
            Assert.IsNotNull(material, $"{label} Cube Renderer has no material");

            // Try common texture property names
            Texture tex = material.mainTexture;
            if (tex == null) tex = material.GetTexture("_BaseMap");
            if (tex == null) tex = material.GetTexture("_MainTex");

            return tex as Texture2D;
        }
    }
}
