using System.Text.RegularExpressions;
using DCL.ABConverter;
using NUnit.Framework;

namespace AssetBundleConverter.Tests
{
    [TestFixture]
    [Category("EditModeCI")]
    public class UtilsCidToGuidShould
    {
        private const string CID_A = "bafkreiaie6ke72c3mfq3w5lhrgw6vy2f4u6kymhd66jxgi7baanyutsira";
        private const string CID_B = "bafkreibuffer000000000000000000000000000000000000000000000000";

        [Test]
        public void ProduceIdenticalGuidForSameCid()
        {
            Assert.AreEqual(Utils.CidToGuid(CID_A), Utils.CidToGuid(CID_A));
        }

        [Test]
        public void ProduceDifferentGuidForDifferentCids()
        {
            Assert.AreNotEqual(Utils.CidToGuid(CID_A), Utils.CidToGuid(CID_B));
        }

        [Test]
        public void Produce32HexCharacters()
        {
            Assert.AreEqual(32, Utils.CidToGuid(CID_A).Length);
        }

        [Test]
        public void ProduceLowercaseHexOnly()
        {
            Assert.IsTrue(Regex.IsMatch(Utils.CidToGuid(CID_A), "^[0-9a-f]{32}$"));
        }

        [Test]
        public void MatchManualMd5HexEncoding()
        {
            byte[] data = Utils.md5.ComputeHash(System.Text.Encoding.UTF8.GetBytes(CID_A));
            var sb = new System.Text.StringBuilder();
            foreach (byte b in data) sb.Append(b.ToString("x2"));

            Assert.AreEqual(sb.ToString(), Utils.CidToGuid(CID_A));
        }
    }

    [TestFixture]
    [Category("EditModeCI")]
    public class DeterministicYamlRemapSubAssetIdsShould
    {
        private const string SEED = "QmHash/animatorController";
        private const string OTHER_SEED = "QmOther/animatorController";

        // Realistic .controller / embedded .anim YAML. Two AnimationClip docs
        // (class 74) named "AAA" and "ZZZ" plus the AnimatorController (class 91).
        // The controller references the clips by their localID via {fileID: <id>}.
        // Built-in ids (e.g. 11500000) and small ids must survive untouched.
        private const string CLIP_AAA =
            "--- !u!74 &7400000000000000001\n" +
            "AnimationClip:\n" +
            "  m_Name: AAA\n" +
            "  m_ObjectHideFlags: 0\n";

        private const string CLIP_ZZZ =
            "--- !u!74 &7400000000000000002\n" +
            "AnimationClip:\n" +
            "  m_Name: ZZZ\n" +
            "  m_ObjectHideFlags: 0\n";

        private const string CONTROLLER =
            "--- !u!91 &9100000000000000001\n" +
            "AnimatorController:\n" +
            "  m_Name: MyController\n" +
            "  m_AnimationClips:\n" +
            "  - {fileID: 7400000000000000001}\n" +
            "  - {fileID: 7400000000000000002}\n" +
            "  m_DefaultClip: {fileID: 11500000}\n";

        private const string YAML_HEADER =
            "%YAML 1.1\n" +
            "%TAG !u! tag:unity3d.com,2011:\n";

        private string yamlAaaFirst;
        private string yamlZzzFirst;

        [SetUp]
        public void Setup()
        {
            yamlAaaFirst = YAML_HEADER + CONTROLLER + CLIP_AAA + CLIP_ZZZ;
            yamlZzzFirst = YAML_HEADER + CONTROLLER + CLIP_ZZZ + CLIP_AAA;
        }

        private static string AnchorFor(string yaml, string name)
        {
            // Returns the &<id> anchor of the doc whose m_Name is <name>.
            var match = Regex.Match(
                yaml,
                @"&(-?\d+)\n[A-Za-z]+:\n  m_Name: " + Regex.Escape(name) + "\n");
            Assert.IsTrue(match.Success, $"Could not find anchor for clip '{name}'");
            return match.Groups[1].Value;
        }

        [Test]
        public void ProduceByteIdenticalOutputForSameInputAndSeed()
        {
            string a = DeterministicYaml.RemapSubAssetIds(yamlAaaFirst, SEED);
            string b = DeterministicYaml.RemapSubAssetIds(yamlAaaFirst, SEED);

            Assert.AreEqual(a, b);
        }

        [Test]
        public void ProduceStableOutputWhenCalledTwiceOnAlreadyRemappedText()
        {
            string once = DeterministicYaml.RemapSubAssetIds(yamlAaaFirst, SEED);
            string twice = DeterministicYaml.RemapSubAssetIds(once, SEED);

            // The freshly assigned ids are derived from md5 and are large/negative,
            // so a second pass re-derives the same mapping for the same content order.
            Assert.AreEqual(once, twice);
        }

        [Test]
        public void ProduceDifferentIdsForDifferentSeed()
        {
            string withSeed = DeterministicYaml.RemapSubAssetIds(yamlAaaFirst, SEED);
            string withOther = DeterministicYaml.RemapSubAssetIds(yamlAaaFirst, OTHER_SEED);

            Assert.AreNotEqual(withSeed, withOther);
        }

        [Test]
        public void PreserveBuiltInFileId11500000()
        {
            string result = DeterministicYaml.RemapSubAssetIds(yamlAaaFirst, SEED);

            Assert.IsTrue(result.Contains("m_DefaultClip: {fileID: 11500000}"));
        }

        [Test]
        public void PreserveSmallIdsBelowThreshold()
        {
            // ids with Math.Abs(id) < 10_000_000 are never remapped.
            string yaml = YAML_HEADER +
                          "--- !u!91 &100\n" +
                          "AnimatorController:\n" +
                          "  m_Name: Small\n" +
                          "  ref: {fileID: 100}\n";

            string result = DeterministicYaml.RemapSubAssetIds(yaml, SEED);

            Assert.AreEqual(yaml, result);
        }

        [Test]
        public void RewriteAnchorAndAllReferencesToTheSameNewId()
        {
            string result = DeterministicYaml.RemapSubAssetIds(yamlAaaFirst, SEED);

            // AAA's anchor and the controller's reference to it must agree.
            string aaaAnchor = AnchorFor(result, "AAA");
            Assert.IsTrue(result.Contains("- {fileID: " + aaaAnchor + "}"),
                "Reference to AAA was not rewritten to match its new anchor");
        }

        [Test]
        public void LeaveNoDanglingReferenceToOldIds()
        {
            string result = DeterministicYaml.RemapSubAssetIds(yamlAaaFirst, SEED);

            // The original large localIDs must be gone from both anchors and refs.
            Assert.IsFalse(
                result.Contains("7400000000000000001") || result.Contains("7400000000000000002"),
                "Old localIDs still present after remap");
        }

        [Test]
        public void PreserveTheNumberOfYamlDocuments()
        {
            int before = Regex.Matches(yamlAaaFirst, @"^--- !u!", RegexOptions.Multiline).Count;
            string result = DeterministicYaml.RemapSubAssetIds(yamlAaaFirst, SEED);
            int after = Regex.Matches(result, @"^--- !u!", RegexOptions.Multiline).Count;

            Assert.AreEqual(before, after);
        }

        [Test]
        public void PreserveNonIdTextSuchAsNamesAndClassTags()
        {
            string result = DeterministicYaml.RemapSubAssetIds(yamlAaaFirst, SEED);

            Assert.IsTrue(
                result.Contains("--- !u!74 ") &&
                result.Contains("--- !u!91 ") &&
                result.Contains("m_Name: AAA") &&
                result.Contains("m_Name: ZZZ") &&
                result.Contains("m_Name: MyController"));
        }

        [Test]
        public void AssignTheSameIdToTheSameNamedClipRegardlessOfInputOrder()
        {
            // The whole point of content-sorted indexing: the new id for "AAA" must
            // be identical whether AAA's doc appears before or after ZZZ's in input.
            string resultAaaFirst = DeterministicYaml.RemapSubAssetIds(yamlAaaFirst, SEED);
            string resultZzzFirst = DeterministicYaml.RemapSubAssetIds(yamlZzzFirst, SEED);

            Assert.AreEqual(AnchorFor(resultAaaFirst, "AAA"), AnchorFor(resultZzzFirst, "AAA"));
        }

        [Test]
        public void AssignTheSameIdToZzzRegardlessOfInputOrder()
        {
            string resultAaaFirst = DeterministicYaml.RemapSubAssetIds(yamlAaaFirst, SEED);
            string resultZzzFirst = DeterministicYaml.RemapSubAssetIds(yamlZzzFirst, SEED);

            Assert.AreEqual(AnchorFor(resultAaaFirst, "ZZZ"), AnchorFor(resultZzzFirst, "ZZZ"));
        }

        [Test]
        public void ReturnInputUnchangedWhenNoSubAssetDocsPresent()
        {
            const string yaml =
                "fileFormatVersion: 2\n" +
                "guid: deadbeefdeadbeefdeadbeefdeadbeef\n" +
                "NativeFormatImporter:\n";

            Assert.AreEqual(yaml, DeterministicYaml.RemapSubAssetIds(yaml, SEED));
        }

        [Test]
        public void RemapASingleSubAsset()
        {
            string yaml = YAML_HEADER + CLIP_AAA;

            string result = DeterministicYaml.RemapSubAssetIds(yaml, SEED);

            Assert.AreNotEqual("7400000000000000001", AnchorFor(result, "AAA"));
        }
    }

    [TestFixture]
    [Category("EditModeCI")]
    public class DeterministicYamlReorderTosOrderShould
    {
        // Mapping form, deliberately out of CRC order: 23966416, then 0, then a
        // smaller-than-23966416 key (12345) to force an actual reorder.
        private const string TOS_MAPPING_UNSORTED =
            "AnimatorController:\n" +
            "  m_Name: MyController\n" +
            "  m_TOS:\n" +
            "    23966416: Loop\n" +
            "    0: \n" +
            "    12345: Armature\n" +
            "  m_StateMachineBehaviours: []\n";

        private const string TOS_MAPPING_SORTED =
            "AnimatorController:\n" +
            "  m_Name: MyController\n" +
            "  m_TOS:\n" +
            "    0: \n" +
            "    12345: Armature\n" +
            "    23966416: Loop\n" +
            "  m_StateMachineBehaviours: []\n";

        // Sequence form (first/second pairs), out of CRC order.
        private const string TOS_SEQUENCE_UNSORTED =
            "AnimatorController:\n" +
            "  m_Name: MyController\n" +
            "  m_TOS:\n" +
            "  - first: 23966416\n" +
            "    second: Loop\n" +
            "  - first: 0\n" +
            "    second: \n" +
            "  - first: 12345\n" +
            "    second: Armature\n" +
            "  m_StateMachineBehaviours: []\n";

        [Test]
        public void SortMappingFormEntriesAscendingByCrcKey()
        {
            Assert.AreEqual(TOS_MAPPING_SORTED, DeterministicYaml.ReorderTosOrder(TOS_MAPPING_UNSORTED));
        }

        [Test]
        public void SortSequenceFormEntriesAscendingByCrcKey()
        {
            string result = DeterministicYaml.ReorderTosOrder(TOS_SEQUENCE_UNSORTED);

            int idxZero = result.IndexOf("first: 0", System.StringComparison.Ordinal);
            int idxMid = result.IndexOf("first: 12345", System.StringComparison.Ordinal);
            int idxHigh = result.IndexOf("first: 23966416", System.StringComparison.Ordinal);

            Assert.IsTrue(idxZero < idxMid && idxMid < idxHigh,
                "Sequence-form m_TOS entries were not sorted ascending by crc");
        }

        [Test]
        public void KeepSecondLineWithItsFirstLineWhenReorderingSequenceForm()
        {
            string result = DeterministicYaml.ReorderTosOrder(TOS_SEQUENCE_UNSORTED);

            // The continuation "second:" must travel with its "- first:" header.
            Assert.IsTrue(result.Contains("  - first: 0\n    second: \n"),
                "second: continuation was detached from its first: entry");
        }

        [Test]
        public void ReturnAlreadySortedMappingUnchanged()
        {
            Assert.AreEqual(TOS_MAPPING_SORTED, DeterministicYaml.ReorderTosOrder(TOS_MAPPING_SORTED));
        }

        [Test]
        public void LeaveTextOutsideTosBlocksByteIdentical()
        {
            string result = DeterministicYaml.ReorderTosOrder(TOS_MAPPING_UNSORTED);

            Assert.IsTrue(
                result.StartsWith("AnimatorController:\n  m_Name: MyController\n  m_TOS:\n") &&
                result.EndsWith("  m_StateMachineBehaviours: []\n"));
        }

        [Test]
        public void PreserveCrlfLineEndings()
        {
            string crlf =
                "AnimatorController:\r\n" +
                "  m_Name: MyController\r\n" +
                "  m_TOS:\r\n" +
                "    23966416: Loop\r\n" +
                "    0: \r\n" +
                "  m_StateMachineBehaviours: []\r\n";

            string result = DeterministicYaml.ReorderTosOrder(crlf);

            // Reordered (so output differs) but every terminator must remain CRLF.
            Assert.IsFalse(Regex.IsMatch(result, "(?<!\r)\n"),
                "A line terminator was emitted as LF instead of CRLF");
        }

        [Test]
        public void EmitReorderedCrlfBlockAscendingByCrc()
        {
            string crlf =
                "  m_TOS:\r\n" +
                "    23966416: Loop\r\n" +
                "    0: \r\n";

            string expected =
                "  m_TOS:\r\n" +
                "    0: \r\n" +
                "    23966416: Loop\r\n";

            Assert.AreEqual(expected, DeterministicYaml.ReorderTosOrder(crlf));
        }

        [Test]
        public void ReturnInputUnchangedWhenNoTosBlockPresent()
        {
            const string yaml =
                "AnimatorController:\n" +
                "  m_Name: MyController\n" +
                "  m_StateMachineBehaviours: []\n";

            Assert.AreEqual(yaml, DeterministicYaml.ReorderTosOrder(yaml));
        }

        [Test]
        public void ReturnInputUnchangedWhenTosBlockIsEmpty()
        {
            const string yaml =
                "AnimatorController:\n" +
                "  m_Name: MyController\n" +
                "  m_TOS:\n" +
                "  m_StateMachineBehaviours: []\n";

            Assert.AreEqual(yaml, DeterministicYaml.ReorderTosOrder(yaml));
        }
    }
}
