using System.Collections.Generic;
using AssetBundleConverter.Wrappers.Interfaces;
using DCL;
using DCL.ABConverter;
using NSubstitute;
using NUnit.Framework;
using UnityEngine;

namespace AssetBundleConverter.Tests
{
    [TestFixture]
    [Category("EditModeCI")]
    public class AssetBundleMetadataBuilderShould
    {
        private const string OUTPUT_PATH = "Assets/Output";
        private const string VERSION = "test-version";
        private const string HASH = "bafkreiaie6ke72c3mfq3w5lhrgw6vy2f4u6kymhd66jxgi7baanyutsira";
        private const string DIGEST = "5d0481fc69cbe8ec4be5fb899e054043";
        private const string METADATA_PATH = OUTPUT_PATH + "/" + HASH + "/metadata.json";

        private IFile file;
        private IAssetBundleManifest manifest;
        private Dictionary<string, string> bundleNameToHash;
        private string capturedJson;

        [SetUp]
        public void Setup()
        {
            file = Substitute.For<IFile>();
            manifest = Substitute.For<IAssetBundleManifest>();
            bundleNameToHash = new Dictionary<string, string>();
            capturedJson = null;

            file.WriteAllText(Arg.Any<string>(), Arg.Do<string>(json => capturedJson = json));
        }

        private AssetBundleMetadata ParseCaptured()
        {
            Assert.IsNotNull(capturedJson, "Expected metadata.json to be written");
            return JsonUtility.FromJson<AssetBundleMetadata>(capturedJson);
        }

        [Test]
        public void WriteMetadataForBareNamedBundles()
        {
            var bundleName = HASH + "_mac";
            bundleNameToHash[bundleName] = HASH;
            manifest.GetAllAssetBundles().Returns(new[] { bundleName });
            manifest.GetAllDependencies(bundleName).Returns(new string[0]);

            AssetBundleMetadataBuilder.Generate(file, OUTPUT_PATH, bundleNameToHash, manifest, VERSION);

            file.Received(1).WriteAllText(METADATA_PATH, Arg.Any<string>());
            var metadata = ParseCaptured();
            Assert.AreEqual(VERSION, metadata.version);
            Assert.Greater(metadata.timestamp, 0);
        }

        [Test]
        public void WriteMetadataForCompositeNamedBundles()
        {
            var bundleName = $"{HASH}_{DIGEST}_mac";
            bundleNameToHash[bundleName] = HASH;
            manifest.GetAllAssetBundles().Returns(new[] { bundleName });
            manifest.GetAllDependencies(bundleName).Returns(new string[0]);

            AssetBundleMetadataBuilder.Generate(file, OUTPUT_PATH, bundleNameToHash, manifest, VERSION);

            file.Received(1).WriteAllText(METADATA_PATH, Arg.Any<string>());
            var metadata = ParseCaptured();
            Assert.AreEqual(VERSION, metadata.version);
            Assert.Greater(metadata.timestamp, 0);
        }

        [Test]
        public void SkipBundlesNotInTheLookupMap()
        {
            manifest.GetAllAssetBundles().Returns(new[] { "dcl/scene_ignore_mac" });
            manifest.GetAllDependencies(Arg.Any<string>()).Returns(new string[0]);

            AssetBundleMetadataBuilder.Generate(file, OUTPUT_PATH, bundleNameToHash, manifest, VERSION);

            file.DidNotReceive().WriteAllText(Arg.Any<string>(), Arg.Any<string>());
        }

        [Test]
        public void SkipEmptyAndNullBundleNames()
        {
            manifest.GetAllAssetBundles().Returns(new[] { "", null });

            AssetBundleMetadataBuilder.Generate(file, OUTPUT_PATH, bundleNameToHash, manifest, VERSION);

            file.DidNotReceive().WriteAllText(Arg.Any<string>(), Arg.Any<string>());
        }

        [Test]
        public void FilterIgnoreSuffixedDepsAndKeepValidOnes()
        {
            var bundleName = $"{HASH}_{DIGEST}_mac";
            const string KEPT_DEP = "bafkreitexture_mac";
            const string FILTERED_DEP = "dcl/scene_IGNORE_mac";

            bundleNameToHash[bundleName] = HASH;
            manifest.GetAllAssetBundles().Returns(new[] { bundleName });
            manifest.GetAllDependencies(bundleName).Returns(new[] { KEPT_DEP, FILTERED_DEP });

            AssetBundleMetadataBuilder.Generate(file, OUTPUT_PATH, bundleNameToHash, manifest, VERSION);

            var metadata = ParseCaptured();
            Assert.AreEqual(1, metadata.dependencies.Length);
            Assert.AreEqual(KEPT_DEP, metadata.dependencies[0]);
        }

        [Test]
        public void WriteDependenciesInMetadata()
        {
            var bundleName = HASH + "_mac";
            const string DEP_A = "bafkreitexture_mac";
            const string DEP_B = "bafkreibuffer_mac";

            bundleNameToHash[bundleName] = HASH;
            manifest.GetAllAssetBundles().Returns(new[] { bundleName });
            manifest.GetAllDependencies(bundleName).Returns(new[] { DEP_A, DEP_B });

            AssetBundleMetadataBuilder.Generate(file, OUTPUT_PATH, bundleNameToHash, manifest, VERSION);

            var metadata = ParseCaptured();
            Assert.AreEqual(2, metadata.dependencies.Length);
            Assert.AreEqual(DEP_A, metadata.dependencies[0]);
            Assert.AreEqual(DEP_B, metadata.dependencies[1]);
        }

        [Test]
        public void ResolveDepNamesViaBundleNameToHash()
        {
            var bundleName = HASH + "_mac";
            const string DEP_BUNDLE = "lowercasehash_mac";
            const string DEP_PROPER = "ProperCasedHash";

            bundleNameToHash[bundleName] = HASH;
            bundleNameToHash[DEP_BUNDLE] = DEP_PROPER;
            manifest.GetAllAssetBundles().Returns(new[] { bundleName });
            manifest.GetAllDependencies(bundleName).Returns(new[] { DEP_BUNDLE });

            AssetBundleMetadataBuilder.Generate(file, OUTPUT_PATH, bundleNameToHash, manifest, VERSION);

            var metadata = ParseCaptured();
            Assert.AreEqual(1, metadata.dependencies.Length);
            Assert.AreEqual(DEP_PROPER, metadata.dependencies[0]);
        }

        [Test]
        public void WriteEmptyDepsWhenBundleHasNoDependencies()
        {
            var bundleName = HASH + "_mac";
            bundleNameToHash[bundleName] = HASH;
            manifest.GetAllAssetBundles().Returns(new[] { bundleName });
            manifest.GetAllDependencies(bundleName).Returns(new string[0]);

            AssetBundleMetadataBuilder.Generate(file, OUTPUT_PATH, bundleNameToHash, manifest, VERSION);

            var metadata = ParseCaptured();
            Assert.IsEmpty(metadata.dependencies);
        }
    }
}
