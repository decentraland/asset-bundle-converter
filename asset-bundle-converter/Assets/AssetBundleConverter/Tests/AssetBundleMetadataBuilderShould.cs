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
        private Dictionary<string, string> lowerCaseHashes;
        private string capturedJson;

        [SetUp]
        public void Setup()
        {
            file = Substitute.For<IFile>();
            manifest = Substitute.For<IAssetBundleManifest>();
            bundleNameToHash = new Dictionary<string, string>();
            lowerCaseHashes = new Dictionary<string, string>();
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

            AssetBundleMetadataBuilder.Generate(file, OUTPUT_PATH, bundleNameToHash, lowerCaseHashes, manifest, VERSION);

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

            AssetBundleMetadataBuilder.Generate(file, OUTPUT_PATH, bundleNameToHash, lowerCaseHashes, manifest, VERSION);

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

            AssetBundleMetadataBuilder.Generate(file, OUTPUT_PATH, bundleNameToHash, lowerCaseHashes, manifest, VERSION);

            file.DidNotReceive().WriteAllText(Arg.Any<string>(), Arg.Any<string>());
        }

        [Test]
        public void SkipEmptyAndNullBundleNames()
        {
            manifest.GetAllAssetBundles().Returns(new[] { "", null });

            AssetBundleMetadataBuilder.Generate(file, OUTPUT_PATH, bundleNameToHash, lowerCaseHashes, manifest, VERSION);

            file.DidNotReceive().WriteAllText(Arg.Any<string>(), Arg.Any<string>());
        }

        [Test]
        public void FilterIgnoreSuffixedDepsAndKeepValidOnes()
        {
            var bundleName = $"{HASH}_{DIGEST}_mac";
            const string KEPT_DEP = "bafkreitexture_mac";
            const string FILTERED_DEP = "dcl/scene_IGNORE_mac";

            bundleNameToHash[bundleName] = HASH;
            bundleNameToHash[KEPT_DEP] = "bafkreitexture";
            manifest.GetAllAssetBundles().Returns(new[] { bundleName });
            manifest.GetAllDependencies(bundleName).Returns(new[] { KEPT_DEP, FILTERED_DEP });

            AssetBundleMetadataBuilder.Generate(file, OUTPUT_PATH, bundleNameToHash, lowerCaseHashes, manifest, VERSION);

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
            bundleNameToHash[DEP_A] = "bafkreitexture";
            bundleNameToHash[DEP_B] = "bafkreibuffer";
            manifest.GetAllAssetBundles().Returns(new[] { bundleName });
            manifest.GetAllDependencies(bundleName).Returns(new[] { DEP_A, DEP_B });

            AssetBundleMetadataBuilder.Generate(file, OUTPUT_PATH, bundleNameToHash, lowerCaseHashes, manifest, VERSION);

            var metadata = ParseCaptured();
            Assert.AreEqual(2, metadata.dependencies.Length);
            Assert.AreEqual(DEP_A, metadata.dependencies[0]);
            Assert.AreEqual(DEP_B, metadata.dependencies[1]);
        }

        [Test]
        public void PreserveBundleNamesWithPlatformSuffixInDeps()
        {
            var bundleName = HASH + "_mac";
            const string DEP_BUNDLE = "lowercasehash_mac";

            bundleNameToHash[bundleName] = HASH;
            bundleNameToHash[DEP_BUNDLE] = "ProperCasedHash";
            manifest.GetAllAssetBundles().Returns(new[] { bundleName });
            manifest.GetAllDependencies(bundleName).Returns(new[] { DEP_BUNDLE });

            AssetBundleMetadataBuilder.Generate(file, OUTPUT_PATH, bundleNameToHash, lowerCaseHashes, manifest, VERSION);

            var metadata = ParseCaptured();
            Assert.AreEqual(1, metadata.dependencies.Length);
            Assert.AreEqual(DEP_BUNDLE, metadata.dependencies[0]);
        }

        [Test]
        public void ExcludeDepsNotInBundleNameToHash()
        {
            var bundleName = HASH + "_mac";
            const string KNOWN_DEP = "bafkreitexture_mac";
            const string UNKNOWN_DEP = "unknownbundle_mac";

            bundleNameToHash[bundleName] = HASH;
            bundleNameToHash[KNOWN_DEP] = "bafkreitexture";
            manifest.GetAllAssetBundles().Returns(new[] { bundleName });
            manifest.GetAllDependencies(bundleName).Returns(new[] { KNOWN_DEP, UNKNOWN_DEP });

            AssetBundleMetadataBuilder.Generate(file, OUTPUT_PATH, bundleNameToHash, lowerCaseHashes, manifest, VERSION);

            var metadata = ParseCaptured();
            Assert.AreEqual(1, metadata.dependencies.Length);
            Assert.AreEqual(KNOWN_DEP, metadata.dependencies[0]);
        }

        [Test]
        public void WriteEmptyDepsWhenBundleHasNoDependencies()
        {
            var bundleName = HASH + "_mac";
            bundleNameToHash[bundleName] = HASH;
            manifest.GetAllAssetBundles().Returns(new[] { bundleName });
            manifest.GetAllDependencies(bundleName).Returns(new string[0]);

            AssetBundleMetadataBuilder.Generate(file, OUTPUT_PATH, bundleNameToHash, lowerCaseHashes, manifest, VERSION);

            var metadata = ParseCaptured();
            Assert.IsEmpty(metadata.dependencies);
        }

        [Test]
        public void WriteMetadataForMixedCaseQmBundles()
        {
            // Unity lowercases assigned bundle names, so the manifest reports the lowercased form
            // while bundleNameToHash is keyed by the original-case CIDv0 hash.
            const string QM_HASH = "Qmay4MXiQauhHtKZJp5rCcmhzU2xDvRnv5fvH1thk2pk5V";
            var bundleName = QM_HASH + "_mac";
            string lowercasedBundleName = bundleName.ToLowerInvariant();

            bundleNameToHash[bundleName] = QM_HASH;
            lowerCaseHashes[QM_HASH.ToLowerInvariant()] = QM_HASH;
            manifest.GetAllAssetBundles().Returns(new[] { lowercasedBundleName });
            manifest.GetAllDependencies(lowercasedBundleName).Returns(new string[0]);

            AssetBundleMetadataBuilder.Generate(file, OUTPUT_PATH, bundleNameToHash, lowerCaseHashes, manifest, VERSION);

            file.Received(1).WriteAllText(OUTPUT_PATH + "/" + QM_HASH + "/metadata.json", Arg.Any<string>());
        }

        [Test]
        public void WriteMetadataForMixedCaseCompositeNamedBundles()
        {
            const string QM_HASH = "QmRYcoT9Kf4XyojgBAGiztztw34Lg8MpBMqrqk1o4B14mG";
            var bundleName = $"{QM_HASH}_{DIGEST}_mac";
            string lowercasedBundleName = bundleName.ToLowerInvariant();

            bundleNameToHash[bundleName] = QM_HASH;
            lowerCaseHashes[QM_HASH.ToLowerInvariant()] = QM_HASH;
            manifest.GetAllAssetBundles().Returns(new[] { lowercasedBundleName });
            manifest.GetAllDependencies(lowercasedBundleName).Returns(new string[0]);

            AssetBundleMetadataBuilder.Generate(file, OUTPUT_PATH, bundleNameToHash, lowerCaseHashes, manifest, VERSION);

            file.Received(1).WriteAllText(OUTPUT_PATH + "/" + QM_HASH + "/metadata.json", Arg.Any<string>());
        }

        [Test]
        public void KeepBafkBehaviourByteIdenticalWithPopulatedLowercaseMap()
        {
            // Retrocompatibility pin: production always fills lowerCaseHashes with identity entries
            // for all-lowercase (bafk...) hashes, and those entries must not alter any output —
            // same metadata path, dependency names byte-identical to the manifest's.
            var bundleName = HASH + "_mac";
            const string DEP_A = "bafkreitexture_mac";
            const string DEP_B = "bafkreibuffer_mac";

            bundleNameToHash[bundleName] = HASH;
            bundleNameToHash[DEP_A] = "bafkreitexture";
            bundleNameToHash[DEP_B] = "bafkreibuffer";
            lowerCaseHashes[HASH] = HASH;
            lowerCaseHashes["bafkreitexture"] = "bafkreitexture";
            lowerCaseHashes["bafkreibuffer"] = "bafkreibuffer";
            manifest.GetAllAssetBundles().Returns(new[] { bundleName });
            manifest.GetAllDependencies(bundleName).Returns(new[] { DEP_A, DEP_B });

            AssetBundleMetadataBuilder.Generate(file, OUTPUT_PATH, bundleNameToHash, lowerCaseHashes, manifest, VERSION);

            file.Received(1).WriteAllText(METADATA_PATH, Arg.Any<string>());
            var metadata = ParseCaptured();
            Assert.AreEqual(new[] { DEP_A, DEP_B }, metadata.dependencies);
        }

        [Test]
        public void KeepBafkCompositeNamedBundlesByteIdenticalWithPopulatedLowercaseMap()
        {
            var bundleName = $"{HASH}_{DIGEST}_mac";
            const string DEP = "bafkreitexture_mac";

            bundleNameToHash[bundleName] = HASH;
            bundleNameToHash[DEP] = "bafkreitexture";
            lowerCaseHashes[HASH] = HASH;
            lowerCaseHashes["bafkreitexture"] = "bafkreitexture";
            manifest.GetAllAssetBundles().Returns(new[] { bundleName });
            manifest.GetAllDependencies(bundleName).Returns(new[] { DEP });

            AssetBundleMetadataBuilder.Generate(file, OUTPUT_PATH, bundleNameToHash, lowerCaseHashes, manifest, VERSION);

            file.Received(1).WriteAllText(METADATA_PATH, Arg.Any<string>());
            var metadata = ParseCaptured();
            Assert.AreEqual(new[] { DEP }, metadata.dependencies);
        }

        [Test]
        public void KeepMetadataJsonWireFormatStable()
        {
            // Clients deserialize this payload with JsonUtility — pin the exact field set,
            // order and formatting so a change here can't silently break them.
            var bundleName = HASH + "_mac";
            const string DEP = "bafkreitexture_mac";

            bundleNameToHash[bundleName] = HASH;
            bundleNameToHash[DEP] = "bafkreitexture";
            manifest.GetAllAssetBundles().Returns(new[] { bundleName });
            manifest.GetAllDependencies(bundleName).Returns(new[] { DEP });

            AssetBundleMetadataBuilder.Generate(file, OUTPUT_PATH, bundleNameToHash, lowerCaseHashes, manifest, VERSION);

            string normalizedJson = System.Text.RegularExpressions.Regex.Replace(capturedJson, "\"timestamp\":\\d+", "\"timestamp\":0");
            Assert.AreEqual($"{{\"timestamp\":0,\"version\":\"{VERSION}\",\"dependencies\":[\"{DEP}\"],\"mainAsset\":\"\"}}", normalizedJson);
        }

        [Test]
        public void HandleMixedBatchesOfQmAndBafkBundlesIndependently()
        {
            // A Qm entity in the batch must not leak re-casing into bafk outputs and vice versa.
            const string QM_HASH = "Qmay4MXiQauhHtKZJp5rCcmhzU2xDvRnv5fvH1thk2pk5V";
            var bafkBundle = HASH + "_windows";
            var qmBundle = QM_HASH + "_windows";
            const string BAFK_DEP = "bafkreitexture_windows";
            const string QM_DEP = "QmbcVjrVGDWwdCMdXQjpyzui2bCX4zaR8XwvkwFuBZvto3_windows";

            bundleNameToHash[bafkBundle] = HASH;
            bundleNameToHash[qmBundle] = QM_HASH;
            bundleNameToHash[BAFK_DEP] = "bafkreitexture";
            bundleNameToHash[QM_DEP] = "QmbcVjrVGDWwdCMdXQjpyzui2bCX4zaR8XwvkwFuBZvto3";
            lowerCaseHashes[HASH] = HASH;
            lowerCaseHashes["bafkreitexture"] = "bafkreitexture";
            lowerCaseHashes[QM_HASH.ToLowerInvariant()] = QM_HASH;
            lowerCaseHashes[QM_DEP.Replace("_windows", "").ToLowerInvariant()] = QM_DEP.Replace("_windows", "");

            var capturedByPath = new Dictionary<string, string>();
            file.When(f => f.WriteAllText(Arg.Any<string>(), Arg.Any<string>()))
                .Do(call => capturedByPath[call.ArgAt<string>(0)] = call.ArgAt<string>(1));

            manifest.GetAllAssetBundles().Returns(new[] { bafkBundle, qmBundle.ToLowerInvariant() });
            manifest.GetAllDependencies(bafkBundle).Returns(new[] { BAFK_DEP });
            manifest.GetAllDependencies(qmBundle.ToLowerInvariant()).Returns(new[] { QM_DEP.ToLowerInvariant() });

            AssetBundleMetadataBuilder.Generate(file, OUTPUT_PATH, bundleNameToHash, lowerCaseHashes, manifest, VERSION);

            var bafkMetadata = JsonUtility.FromJson<AssetBundleMetadata>(capturedByPath[METADATA_PATH]);
            Assert.AreEqual(new[] { BAFK_DEP }, bafkMetadata.dependencies, "bafk deps must stay verbatim");

            var qmMetadata = JsonUtility.FromJson<AssetBundleMetadata>(capturedByPath[OUTPUT_PATH + "/" + QM_HASH + "/metadata.json"]);
            Assert.AreEqual(new[] { QM_DEP }, qmMetadata.dependencies, "Qm deps must be re-cased to canonical names");
        }

        [Test]
        public void KeepQmDependenciesLowercaseOnMac()
        {
            // Mac bundles ship under Unity's lowercased names, so the dep entries — fetched verbatim
            // by clients — must stay lowercase too, matching the files and the historical mac contract.
            const string QM_HASH = "Qmay4MXiQauhHtKZJp5rCcmhzU2xDvRnv5fvH1thk2pk5V";
            const string QM_DEP_HASH = "QmbcVjrVGDWwdCMdXQjpyzui2bCX4zaR8XwvkwFuBZvto3";
            var bundleName = QM_HASH + "_mac";
            var depBundleName = QM_DEP_HASH + "_mac";
            string lowercasedBundleName = bundleName.ToLowerInvariant();

            bundleNameToHash[bundleName] = QM_HASH;
            bundleNameToHash[depBundleName] = QM_DEP_HASH;
            lowerCaseHashes[QM_HASH.ToLowerInvariant()] = QM_HASH;
            lowerCaseHashes[QM_DEP_HASH.ToLowerInvariant()] = QM_DEP_HASH;
            manifest.GetAllAssetBundles().Returns(new[] { lowercasedBundleName });
            manifest.GetAllDependencies(lowercasedBundleName).Returns(new[] { depBundleName.ToLowerInvariant() });

            AssetBundleMetadataBuilder.Generate(file, OUTPUT_PATH, bundleNameToHash, lowerCaseHashes, manifest, VERSION);

            var metadata = ParseCaptured();
            Assert.AreEqual(1, metadata.dependencies.Length);
            Assert.AreEqual(depBundleName.ToLowerInvariant(), metadata.dependencies[0]);
        }

        [Test]
        public void RecaseQmDependenciesToOriginalCasingOnWindows()
        {
            // Windows files ship under the original casing, so the dep entries — fetched verbatim by
            // clients — must be re-cased to match: a lowercased entry 404s on the case-sensitive CDN.
            const string QM_HASH = "Qmay4MXiQauhHtKZJp5rCcmhzU2xDvRnv5fvH1thk2pk5V";
            const string QM_DEP_HASH = "QmbcVjrVGDWwdCMdXQjpyzui2bCX4zaR8XwvkwFuBZvto3";
            var bundleName = QM_HASH + "_windows";
            var depBundleName = QM_DEP_HASH + "_windows";
            string lowercasedBundleName = bundleName.ToLowerInvariant();

            bundleNameToHash[bundleName] = QM_HASH;
            bundleNameToHash[depBundleName] = QM_DEP_HASH;
            lowerCaseHashes[QM_HASH.ToLowerInvariant()] = QM_HASH;
            lowerCaseHashes[QM_DEP_HASH.ToLowerInvariant()] = QM_DEP_HASH;
            manifest.GetAllAssetBundles().Returns(new[] { lowercasedBundleName });
            manifest.GetAllDependencies(lowercasedBundleName).Returns(new[] { depBundleName.ToLowerInvariant() });

            AssetBundleMetadataBuilder.Generate(file, OUTPUT_PATH, bundleNameToHash, lowerCaseHashes, manifest, VERSION);

            var metadata = ParseCaptured();
            Assert.AreEqual(1, metadata.dependencies.Length);
            Assert.AreEqual(depBundleName, metadata.dependencies[0]);
        }
    }

    [TestFixture]
    [Category("EditModeCI")]
    public class CleanAssetBundleFolderShould
    {
        private const string PATH = "Assets/Output/";
        private const string QM_HASH = "Qmay4MXiQauhHtKZJp5rCcmhzU2xDvRnv5fvH1thk2pk5V";
        private const string BAFK_HASH = "bafkreiaie6ke72c3mfq3w5lhrgw6vy2f4u6kymhd66jxgi7baanyutsira";
        private const string DIGEST = "5d0481fc69cbe8ec4be5fb899e054043";

        private static readonly string QM_LOWER = QM_HASH.ToLowerInvariant();

        private IFile file;
        private Dictionary<string, string> lowerToUpper;

        [SetUp]
        public void Setup()
        {
            file = Substitute.For<IFile>();

            lowerToUpper = new Dictionary<string, string>
            {
                [QM_LOWER] = QM_HASH,
                [BAFK_HASH] = BAFK_HASH,
            };
        }

        [Test]
        public void RecaseCompositeDigestNamesCanonically()
        {
            Assert.AreEqual($"{QM_HASH}_{DIGEST}_mac", DCL.ABConverter.Utils.GetCanonicalBundleFileName($"{QM_LOWER}_{DIGEST}_mac", lowerToUpper));
        }

        [Test]
        public void KeepUnknownNamesVerbatim()
        {
            Assert.AreEqual("dcl/scene_IGNORE_mac", DCL.ABConverter.Utils.GetCanonicalBundleFileName("dcl/scene_IGNORE_mac", lowerToUpper));
            Assert.AreEqual("dcl/scene_IGNORE_windows", DCL.ABConverter.Utils.GetCdnFileName("dcl/scene_IGNORE_windows", lowerToUpper));
        }

        [Test]
        public void ResolveCdnFileNamesPerPlatform()
        {
            // Mac ships Unity's lowercase name verbatim; other platforms re-case to the original hash.
            Assert.AreEqual(QM_LOWER + "_mac", DCL.ABConverter.Utils.GetCdnFileName(QM_LOWER + "_mac", lowerToUpper));
            Assert.AreEqual(QM_HASH + "_windows", DCL.ABConverter.Utils.GetCdnFileName(QM_LOWER + "_windows", lowerToUpper));
            Assert.AreEqual($"{QM_LOWER}_{DIGEST}_mac", DCL.ABConverter.Utils.GetCdnFileName($"{QM_LOWER}_{DIGEST}_mac", lowerToUpper));
            Assert.AreEqual($"{QM_HASH}_{DIGEST}_windows", DCL.ABConverter.Utils.GetCdnFileName($"{QM_LOWER}_{DIGEST}_windows", lowerToUpper));
        }

        [Test]
        public void LeaveMacBundlesUntouched()
        {
            // The mac contract is Unity's lowercase naming — the name every mac client derives and
            // every pre-v49 mac bundle already uses — so no rename (and no alias copy) may happen.
            DCL.ABConverter.Utils.CleanAssetBundleFolder(file, PATH, new[]
            {
                QM_LOWER + "_mac",
                $"{QM_LOWER}_{DIGEST}_mac",
                BAFK_HASH + "_mac",
            }, lowerToUpper);

            file.DidNotReceive().Move(Arg.Any<string>(), Arg.Any<string>());
            file.DidNotReceive().Copy(Arg.Any<string>(), Arg.Any<string>());
        }

        [Test]
        public void RenameQmWindowsBundlesToOriginalCasing()
        {
            DCL.ABConverter.Utils.CleanAssetBundleFolder(file, PATH, new[] { QM_LOWER + "_windows" }, lowerToUpper);

            file.Received(1).Move(PATH + QM_LOWER + "_windows", PATH + QM_HASH + "_windows");
            file.DidNotReceive().Copy(Arg.Any<string>(), Arg.Any<string>());
        }

        [Test]
        public void LeaveAllLowercaseBundlesUntouched()
        {
            DCL.ABConverter.Utils.CleanAssetBundleFolder(file, PATH, new[] { BAFK_HASH + "_windows" }, lowerToUpper);

            file.DidNotReceive().Move(Arg.Any<string>(), Arg.Any<string>());
            file.DidNotReceive().Copy(Arg.Any<string>(), Arg.Any<string>());
        }

        [Test]
        public void LeaveAllLowercaseBundlesUntouchedAcrossPlatformsAndNamings()
        {
            // Retrocompatibility pin: bafk... outputs (bare, digest-named, any platform) keep the
            // exact file names Unity produced — no renames, no alias copies.
            DCL.ABConverter.Utils.CleanAssetBundleFolder(file, PATH, new[]
            {
                BAFK_HASH + "_windows",
                $"{BAFK_HASH}_{DIGEST}_mac",
                $"{BAFK_HASH}_{DIGEST}_windows",
            }, lowerToUpper);

            file.DidNotReceive().Move(Arg.Any<string>(), Arg.Any<string>());
            file.DidNotReceive().Copy(Arg.Any<string>(), Arg.Any<string>());
        }

        [Test]
        public void OnlyTouchQmWindowsBundlesInMixedBatches()
        {
            DCL.ABConverter.Utils.CleanAssetBundleFolder(file, PATH, new[]
            {
                BAFK_HASH + "_windows",
                QM_LOWER + "_windows",
                QM_LOWER + "_mac",
            }, lowerToUpper);

            file.Received(1).Move(PATH + QM_LOWER + "_windows", PATH + QM_HASH + "_windows");
            file.DidNotReceive().Move(PATH + BAFK_HASH + "_windows", Arg.Any<string>());
            file.DidNotReceive().Move(PATH + QM_LOWER + "_mac", Arg.Any<string>());
            file.DidNotReceive().Copy(Arg.Any<string>(), Arg.Any<string>());
        }

        [Test]
        public void DeleteUnityManifestFilesForEveryBundleRegardlessOfCasing()
        {
            // The per-bundle .manifest cleanup must keep working for both untouched bafk names
            // and renamed Qm names (the .manifest sits next to Unity's original output name).
            DCL.ABConverter.Utils.CleanAssetBundleFolder(file, PATH, new[]
            {
                BAFK_HASH + "_mac",
                QM_LOWER + "_mac",
            }, lowerToUpper);

            file.Received(1).Delete(PATH + BAFK_HASH + "_mac.manifest");
            file.Received(1).Delete(PATH + QM_LOWER + "_mac.manifest");
        }
    }
}
