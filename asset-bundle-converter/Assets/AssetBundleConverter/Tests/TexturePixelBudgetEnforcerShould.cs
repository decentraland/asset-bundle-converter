using AssetBundleConverter;
using DCL;
using NSubstitute;
using NUnit.Framework;

namespace UNITY_INCLUDE_TESTS.AssetBundleConverter.Tests
{
    [TestFixture]
    [Category("EditModeCI")]
    public class TexturePixelBudgetEnforcerShould
    {
        private const long ONE_PARCEL_BUDGET = 2048L * 2048; // 4,194,304 px
        private const string GLTF_A = "Assets/_Downloaded/gltf_abc123/Textures/";
        private const string GLTF_B = "Assets/_Downloaded/gltf_def456/Textures/";
        private const string GLTF_C = "Assets/_Downloaded/gltf_ghi789/Textures/";

        private IFile file;
        private IAssetDatabase assetDatabase;
        private IABLogger log;

        [SetUp]
        public void SetUp()
        {
            file = Substitute.For<IFile>();
            assetDatabase = Substitute.For<IAssetDatabase>();
            log = Substitute.For<IABLogger>();
        }

        private TestableEnforcer CreateEnforcer(int parcelCount = 1) =>
            new (parcelCount, file, assetDatabase, log);

        [Test]
        public void NotResizeWhenUnderBudget()
        {
            var enforcer = CreateEnforcer();
            enforcer.TrackTexture(GLTF_A + "Albedo.png", "Albedo", 1024, 1024, TextureType.MainTex);
            enforcer.TrackTexture(GLTF_A + "Normal.png", "Normal", 1024, 1024, TextureType.MainTex);

            enforcer.EnforceBudgets();

            Assert.AreEqual(0, enforcer.ResizeCallCount);
        }

        [Test]
        public void ResizeSingleTextureOverBudget()
        {
            var enforcer = CreateEnforcer();
            enforcer.TrackTexture(GLTF_A + "BigAlbedo.png", "BigAlbedo", 4096, 4096, TextureType.MainTex);

            enforcer.EnforceBudgets();

            Assert.Greater(enforcer.ResizeCallCount, 0);
            var tex = enforcer.GetTracked(GLTF_A + "BigAlbedo.png");
            Assert.LessOrEqual((long)tex.Width * tex.Height, ONE_PARCEL_BUDGET);
        }

        [Test]
        public void ResizeOnlyLargestWhenOneReductionSuffices()
        {
            var enforcer = CreateEnforcer();
            // Total = 2048*2048 + 1024*1024 = 4,194,304 + 1,048,576 = 5,242,880 > 4,194,304
            enforcer.TrackTexture(GLTF_A + "LargeAlbedo.png", "LargeAlbedo", 2048, 2048, TextureType.MainTex);
            enforcer.TrackTexture(GLTF_B + "SmallAlbedo.png", "SmallAlbedo", 1024, 1024, TextureType.MainTex);

            enforcer.EnforceBudgets();

            var large = enforcer.GetTracked(GLTF_A + "LargeAlbedo.png");
            var small = enforcer.GetTracked(GLTF_B + "SmallAlbedo.png");

            long total = ((long)large.Width * large.Height) + ((long)small.Width * small.Height);
            Assert.LessOrEqual(total, ONE_PARCEL_BUDGET);
            // Small should not have been touched, the large one absorbs the excess
            Assert.AreEqual(1024, small.Width);
            Assert.AreEqual(1024, small.Height);
        }

        [Test]
        public void ClampFactorToHalfAndContinueToNextCandidate()
        {
            var enforcer = CreateEnforcer();
            // Two huge textures, both far over budget
            // Total = 2 * 8192^2 = 134,217,728 >> 4,194,304
            enforcer.TrackTexture(GLTF_A + "HugeA.png", "HugeA", 8192, 8192, TextureType.MainTex);
            enforcer.TrackTexture(GLTF_B + "HugeB.png", "HugeB", 8192, 8192, TextureType.MainTex);

            enforcer.EnforceBudgets();

            var a = enforcer.GetTracked(GLTF_A + "HugeA.png");
            var b = enforcer.GetTracked(GLTF_B + "HugeB.png");
            long total = ((long)a.Width * a.Height) + ((long)b.Width * b.Height);

            Assert.LessOrEqual(total, ONE_PARCEL_BUDGET);
            // Both should have been resized (factor clamp forces spread across candidates)
            Assert.Less(a.Width, 8192);
            Assert.Less(b.Width, 8192);
        }

        [Test]
        public void WrapAroundAndReduceAgain()
        {
            var enforcer = CreateEnforcer();
            // 3 textures, massively over budget, will need multiple passes
            enforcer.TrackTexture(GLTF_A + "Albedo.png", "Albedo", 4096, 4096, TextureType.MainTex);
            enforcer.TrackTexture(GLTF_B + "Albedo.png", "Albedo", 4096, 4096, TextureType.MainTex);
            enforcer.TrackTexture(GLTF_C + "Albedo.png", "Albedo", 4096, 4096, TextureType.MainTex);

            enforcer.EnforceBudgets();

            var a = enforcer.GetTracked(GLTF_A + "Albedo.png");
            var b = enforcer.GetTracked(GLTF_B + "Albedo.png");
            var c = enforcer.GetTracked(GLTF_C + "Albedo.png");
            long total = ((long)a.Width * a.Height) + ((long)b.Width * b.Height) + ((long)c.Width * c.Height);

            Assert.LessOrEqual(total, ONE_PARCEL_BUDGET);
            // All three should have been resized due to wrap-around
            Assert.Less(a.Width, 4096);
            Assert.Less(b.Width, 4096);
            Assert.Less(c.Width, 4096);
        }

        [Test]
        public void NotResizeAlreadyOneByOneTexture()
        {
            var enforcer = CreateEnforcer();
            enforcer.TrackTexture(GLTF_A + "Tiny.png", "Tiny", 1, 1, TextureType.MainTex);

            enforcer.EnforceBudgets();

            Assert.AreEqual(0, enforcer.ResizeCallCount);
        }

        [Test]
        public void ReduceTwoByTwoToOneByOneWhenOverBudget()
        {
            var enforcer = CreateEnforcer();
            // 2048 textures of 64x64 = 2048 * 4096 = 8,388,608 > 4,194,304
            for (int i = 0; i < 2048; i++)
                enforcer.TrackTexture($"{GLTF_A}tex_{i}.png", $"tex_{i}", 64, 64, TextureType.MainTex);

            // Also add a 2x2 as the smallest candidate
            enforcer.TrackTexture(GLTF_B + "Tiny.png", "Tiny", 2, 2, TextureType.MainTex);

            enforcer.EnforceBudgets();

            long total = 0;
            for (int i = 0; i < 2048; i++)
            {
                var t = enforcer.GetTracked($"{GLTF_A}tex_{i}.png");
                total += (long)t.Width * t.Height;
            }
            var tiny = enforcer.GetTracked(GLTF_B + "Tiny.png");
            total += (long)tiny.Width * tiny.Height;

            Assert.LessOrEqual(total, ONE_PARCEL_BUDGET);
        }

        [Test]
        public void ReduceOneByNTexture()
        {
            var enforcer = CreateEnforcer();
            // 1x8192 = 8192 px (well under budget alone, so pair with a large texture)
            // Total = 4096*4096 + 1*8192 = 16,785,408 >> 4,194,304
            enforcer.TrackTexture(GLTF_A + "Wide.png", "Wide", 1, 8192, TextureType.MainTex);
            enforcer.TrackTexture(GLTF_B + "Big.png", "Big", 4096, 4096, TextureType.MainTex);

            enforcer.EnforceBudgets();

            var wide = enforcer.GetTracked(GLTF_A + "Wide.png");
            // Width should stay 1 (Max(1,...)), height should reduce
            Assert.AreEqual(1, wide.Width);
        }

        [Test]
        public void NotResizeWhenNoCandidatesForLayer()
        {
            var enforcer = CreateEnforcer();
            // Only track normal maps, albedo layer should be empty
            enforcer.TrackTexture(GLTF_A + "Normal.png", "Normal", 4096, 4096, TextureType.BumpMap);

            enforcer.EnforceBudgets();

            // Normal was over budget and got resized, but no crash for empty albedo layer
            Assert.Greater(enforcer.ResizeCallCount, 0);
        }

        [Test]
        public void EnforceLayersIndependently()
        {
            var enforcer = CreateEnforcer();
            // Albedo: over budget
            enforcer.TrackTexture(GLTF_A + "Albedo.png", "Albedo", 4096, 4096, TextureType.MainTex);
            // Normal: under budget
            enforcer.TrackTexture(GLTF_A + "Normal.png", "Normal", 1024, 1024, TextureType.BumpMap);

            enforcer.EnforceBudgets();

            var albedo = enforcer.GetTracked(GLTF_A + "Albedo.png");
            var normal = enforcer.GetTracked(GLTF_A + "Normal.png");

            Assert.LessOrEqual((long)albedo.Width * albedo.Height, ONE_PARCEL_BUDGET);
            // Normal should be untouched
            Assert.AreEqual(1024, normal.Width);
            Assert.AreEqual(1024, normal.Height);
        }

        [Test]
        public void ResizeSharedTextureAffectsBothLayers()
        {
            var enforcer = CreateEnforcer();
            // This texture is both albedo and normal, appears in both layers' candidate lists
            enforcer.TrackTexture(GLTF_A + "Shared.png", "Shared", 4096, 4096, TextureType.MainTex | TextureType.BumpMap);

            enforcer.EnforceBudgets();

            var shared = enforcer.GetTracked(GLTF_A + "Shared.png");
            // Should have been resized for albedo layer (over budget: 16M > 4M)
            Assert.LessOrEqual((long)shared.Width * shared.Height, ONE_PARCEL_BUDGET);
            // When normal layer is processed, the texture is already within budget, no extra resize needed
        }

        [Test]
        public void ScaleBudgetWithParcelCount()
        {
            var enforcer = CreateEnforcer(4);
            // 4 parcels -> budget = 4 * 2048^2 = 16,777,216 px
            // 4096x4096 = 16,777,216 px, exactly at budget
            enforcer.TrackTexture(GLTF_A + "Exact.png", "Exact", 4096, 4096, TextureType.MainTex);

            enforcer.EnforceBudgets();

            Assert.AreEqual(0, enforcer.ResizeCallCount);
        }

        [Test]
        public void ResizeWhenOnePixelOverBudget()
        {
            var enforcer = CreateEnforcer();
            // Budget = 4,194,304. Track one 2048x2048 (exactly at budget) + one tiny 2x1 (2px over)
            enforcer.TrackTexture(GLTF_A + "Exact.png", "Exact", 2048, 2048, TextureType.MainTex);
            enforcer.TrackTexture(GLTF_B + "Tiny.png", "Tiny", 2, 1, TextureType.MainTex);

            enforcer.EnforceBudgets();

            var exact = enforcer.GetTracked(GLTF_A + "Exact.png");
            var tiny = enforcer.GetTracked(GLTF_B + "Tiny.png");
            long total = ((long)exact.Width * exact.Height) + ((long)tiny.Width * tiny.Height);
            Assert.LessOrEqual(total, ONE_PARCEL_BUDGET);
        }

        [Test]
        public void SortByPixelCountThenNameThenPath()
        {
            var enforcer = CreateEnforcer();

            // Same size (2048x2048), same name "Albedo" but different GLTF folders
            // Should sort by name first (equal), then by full path (GLTF_A < GLTF_B)
            // The one with alphabetically first path gets reduced first
            enforcer.TrackTexture(GLTF_B + "Albedo.png", "Albedo", 2048, 2048, TextureType.MainTex);
            enforcer.TrackTexture(GLTF_A + "Albedo.png", "Albedo", 2048, 2048, TextureType.MainTex);
            // Smaller texture, different name
            enforcer.TrackTexture(GLTF_C + "Detail.png", "Detail", 512, 512, TextureType.MainTex);

            // Total = 2 * 2048^2 + 512^2 = 8,388,608 + 262,144 = 8,650,752 > 4,194,304
            enforcer.EnforceBudgets();

            var fromA = enforcer.GetTracked(GLTF_A + "Albedo.png");
            var fromB = enforcer.GetTracked(GLTF_B + "Albedo.png");
            var detail = enforcer.GetTracked(GLTF_C + "Detail.png");

            long total = ((long)fromA.Width * fromA.Height) + ((long)fromB.Width * fromB.Height) + ((long)detail.Width * detail.Height);
            Assert.LessOrEqual(total, ONE_PARCEL_BUDGET);

            // GLTF_A path sorts before GLTF_B, so it should be reduced first (at index 0)
            Assert.Less(fromA.Width, 2048, "Texture from GLTF_A should be reduced first (earlier in path order)");
        }

        [Test]
        public void SortByNameBeforePath()
        {
            var enforcer = CreateEnforcer();

            // Same size, different names — name should take priority over path
            // "Alpha" < "Beta" alphabetically, so Alpha sorts first regardless of path
            enforcer.TrackTexture(GLTF_B + "Alpha.png", "Alpha", 2048, 2048, TextureType.MainTex);
            enforcer.TrackTexture(GLTF_A + "Beta.png", "Beta", 2048, 2048, TextureType.MainTex);
            enforcer.TrackTexture(GLTF_C + "Detail.png", "Detail", 512, 512, TextureType.MainTex);

            // Total = 2 * 2048^2 + 512^2 = 8,650,752 > 4,194,304
            enforcer.EnforceBudgets();

            var alpha = enforcer.GetTracked(GLTF_B + "Alpha.png");
            var beta = enforcer.GetTracked(GLTF_A + "Beta.png");

            // Alpha sorts before Beta by name, so it gets reduced first even though its path (GLTF_B) is later
            Assert.Less(alpha.Width, 2048, "Alpha should be reduced first (earlier in name order, despite later path)");
        }

        private class TestableEnforcer : TexturePixelBudgetEnforcer
        {
            public int ResizeCallCount;

            public TestableEnforcer(int parcelCount, IFile file, IAssetDatabase assetDatabase, IABLogger log)
                : base(parcelCount, file, assetDatabase, log) { }

            protected override void ResizeTrackedTexture(TrackedTexture texture, int newWidth, int newHeight)
            {
                texture.Width = newWidth;
                texture.Height = newHeight;
                ResizeCallCount++;
            }

            public TrackedTexture GetTracked(string filePath) =>
                trackedTextures[filePath];
        }
    }
}
