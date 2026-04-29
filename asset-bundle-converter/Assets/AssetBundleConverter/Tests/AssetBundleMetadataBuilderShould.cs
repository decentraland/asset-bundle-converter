using System.Collections.Generic;
using AssetBundleConverter.Wrappers.Interfaces;
using DCL;
using DCL.ABConverter;
using NSubstitute;
using NUnit.Framework;
using UnityEditor;

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
        private Dictionary<string, string> hashLowercaseToProper;
        private BuildTarget previousTarget;

        [SetUp]
        public void Setup()
        {
            // Force a deterministic platform suffix. Edit-mode tests run without an
            // active build target set, so without this `PlatformUtils.GetPlatform()`
            // returns "" and the tests can't exercise the platform-suffix-stripping
            // path that the production bug lives in. We snapshot + restore in
            // `TearDown` because `currentTarget` is process-wide static state that
            // bleeds into other fixtures running in the same edit-mode session
            // (e.g. `AssetBundleConverterShould` reads `GetPlatform()` directly).
            previousTarget = PlatformUtils.currentTarget;
            PlatformUtils.currentTarget = BuildTarget.StandaloneOSX;

            file = Substitute.For<IFile>();
            manifest = Substitute.For<IAssetBundleManifest>();
            hashLowercaseToProper = new Dictionary<string, string> { { HASH, HASH } };
        }

        [TearDown]
        public void TearDown()
        {
            PlatformUtils.currentTarget = previousTarget;
        }

        [Test]
        public void WriteMetadataForBareNamedBundles()
        {
            var bundleName = HASH + "_mac";
            manifest.GetAllAssetBundles().Returns(new[] { bundleName });
            manifest.GetAllDependencies(bundleName).Returns(new string[0]);

            AssetBundleMetadataBuilder.Generate(file, OUTPUT_PATH, hashLowercaseToProper, manifest, VERSION);

            file.Received(1).WriteAllText(METADATA_PATH, Arg.Any<string>());
        }

        [Test]
        public void WriteMetadataForCompositeNamedBundles()
        {
            // Regression: pre-fix, this case never wrote `metadata.json` because the
            // dictionary lookup against `{hash}_{digest}` failed (the map is keyed by
            // raw hash), the `out` parameter overwrote the proper-cased name with null,
            // and the `IsNullOrEmpty` guard short-circuited the write. Result in
            // production: glb bundles got rebuilt without embedded dep metadata, and
            // at runtime the explorer treated them as having zero dependencies — so
            // textures never loaded and materials rendered as default white.
            var bundleName = $"{HASH}_{DIGEST}_mac";
            manifest.GetAllAssetBundles().Returns(new[] { bundleName });
            manifest.GetAllDependencies(bundleName).Returns(new string[0]);

            AssetBundleMetadataBuilder.Generate(file, OUTPUT_PATH, hashLowercaseToProper, manifest, VERSION);

            file.Received(1).WriteAllText(METADATA_PATH, Arg.Any<string>());
        }

        [Test]
        public void SkipBundlesWhoseLeadingHashIsNotInTheLookupMap()
        {
            // `_IGNORE`-suffixed shader bundles, generic Unity artifacts, and anything
            // else whose leading hash isn't in the dictionary should NOT produce a
            // `metadata.json`: the asset folder named after a proper-cased hash doesn't
            // exist for them.
            manifest.GetAllAssetBundles().Returns(new[] { "dcl/scene_ignore_mac" });
            manifest.GetAllDependencies(Arg.Any<string>()).Returns(new string[0]);

            AssetBundleMetadataBuilder.Generate(file, OUTPUT_PATH, hashLowercaseToProper, manifest, VERSION);

            file.DidNotReceive().WriteAllText(Arg.Any<string>(), Arg.Any<string>());
        }

        [Test]
        public void SkipEmptyAndNullBundleNames()
        {
            manifest.GetAllAssetBundles().Returns(new[] { "", null });

            AssetBundleMetadataBuilder.Generate(file, OUTPUT_PATH, hashLowercaseToProper, manifest, VERSION);

            file.DidNotReceive().WriteAllText(Arg.Any<string>(), Arg.Any<string>());
        }

        [Test]
        public void FilterIgnoreSuffixedDepsOutOfTheDependenciesArray()
        {
            // The shared shader bundle is named with the `_IGNORE` token specifically
            // so the metadata builder strips it from every glb's deps list — the
            // explorer sources shaders from streaming assets via the `COMMON_SHADERS`
            // allow-list, not from a per-glb CDN dep fetch.
            var bundleName = $"{HASH}_{DIGEST}_mac";
            const string KEPT_DEP = "bafkreitexture_mac";
            const string FILTERED_DEP = "dcl/scene_IGNORE_mac";

            manifest.GetAllAssetBundles().Returns(new[] { bundleName });
            manifest.GetAllDependencies(bundleName).Returns(new[] { KEPT_DEP, FILTERED_DEP });

            AssetBundleMetadataBuilder.Generate(file, OUTPUT_PATH, hashLowercaseToProper, manifest, VERSION);

            file.Received(1).WriteAllText(
                METADATA_PATH,
                Arg.Is<string>(json => json.Contains(KEPT_DEP) && !json.Contains("IGNORE")));
        }
    }
}
