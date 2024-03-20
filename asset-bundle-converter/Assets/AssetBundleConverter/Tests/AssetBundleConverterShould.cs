using AssetBundleConverter.Editor;
using AssetBundleConverter.Wrappers.Interfaces;
using DCL;
using DCL.ABConverter;
using GLTFast;
using NSubstitute;
using NUnit.Framework;
using System;
using System.Collections.Generic;
using System.IO;
using System.Threading.Tasks;
using UnityEditor;
using UnityEngine;
using Object = UnityEngine.Object;

namespace AssetBundleConverter.Tests
{
    [TestFixture]
    [Category("EditModeCI")]
    public class AssetBundleConverterShould
    {
        private static readonly char separator = Path.DirectorySeparatorChar;
        private static readonly string DOWNLOAD_FOLDER = $"Assets{separator}_Downloaded{separator}";
        private static readonly string EXAMPLE_AB_PATH = $"Example{separator}AssetBundle{separator}";
        private const string EXAMPLE_BASE_URL = "dlc.baseurl/contents/";

        private IFile file;
        private IDirectory directory;
        private IAssetDatabase assetDatabase;
        private IWebRequest webRequest;
        private IBuildPipeline buildPipeline;
        private IGltfImporter gltfImporter;
        private IEditor editor;
        private Environment environment;
        private DCL.ABConverter.AssetBundleConverter converter;
        private IErrorReporter errorReporter;
        private IABLogger abLogger;
        private GameObject dummyGo;

        [SetUp]
        public void Setup()
        {
            dummyGo = new GameObject("gltf");
            directory = Substitute.For<IDirectory>();
            file = Substitute.For<IFile>();
            assetDatabase = Substitute.For<IAssetDatabase>();
            webRequest = Substitute.For<IWebRequest>();
            buildPipeline = Substitute.For<IBuildPipeline>();
            gltfImporter = Substitute.For<IGltfImporter>();
            editor = Substitute.For<IEditor>();
            errorReporter = Substitute.For<IErrorReporter>();
            abLogger = Substitute.For<IABLogger>();

            editor.SwitchBuildTarget(BuildTarget.WebGL).Returns(true);

            //Any error or exit code should make any test fail unless its explicitly required
            errorReporter.When(x => x.ReportError(Arg.Any<string>(), Arg.Any<ClientSettings>())).Do(x => throw new Exception("There was an unexpected error: " + x.Arg<string>()));
            errorReporter.When(x => x.ReportException(Arg.Any<ConversionException>())).Do(x => throw x.Arg<ConversionException>().originalException);
            editor.When(x => x.Exit(Arg.Any<int>())).Do(x => ThrowIfExitCodeIsNotZero(x.Arg<int>()));
            editor.Delay(Arg.Any<TimeSpan>()).Returns(Task.CompletedTask);

            environment = new Environment(directory, file, assetDatabase, webRequest, buildPipeline, gltfImporter, editor, abLogger, errorReporter, BuildPipelineType.Default);

            var clientSettings = new ClientSettings
            {
                finalAssetBundlePath = EXAMPLE_AB_PATH,
                baseUrl = EXAMPLE_BASE_URL,
                visualTest = true,
            };

            converter = new DCL.ABConverter.AssetBundleConverter(environment, clientSettings);
        }

        [TearDown]
        public void TearDown()
        {
            Object.DestroyImmediate(dummyGo);
        }

        private void ThrowIfExitCodeIsNotZero(int exitCode)
        {
            if (exitCode != 0) throw new Exception("Exit code " + exitCode);
        }

        [Test]
        public async Task LoadVisualSceneOnStart()
        {
            await converter.ConvertAsync(new DCL.ABConverter.AssetBundleConverter.ConversionParams());

            await editor.Received().LoadVisualTestSceneAsync();
        }

        [Test]
        public async Task InitializeDirectories()
        {
            await converter.ConvertAsync(new DCL.ABConverter.AssetBundleConverter.ConversionParams());

            directory.Received(1).InitializeDirectory(Arg.Is(EXAMPLE_AB_PATH), Arg.Any<bool>());
        }

        [Test]
        public async Task TextureAssetIsProcessed()
        {
            var exampleAsset = new ContentServerUtils.MappingPair { file = "example.png", hash = "example" };
            var assetPath = new AssetPath(Config.GetDownloadPath(), exampleAsset);

            string directoryName = Path.GetDirectoryName(assetPath.finalPath);
            string exampleBaseURL = EXAMPLE_BASE_URL + exampleAsset.hash;

            directory.Exists(directoryName).Returns(false);
            webRequest.Get(exampleBaseURL).Returns(new DownloadHandlerMock());
            var manifest = Substitute.For<IAssetBundleManifest>();
            buildPipeline.BuildAssetBundles(Arg.Any<string>(), Arg.Any<BuildAssetBundleOptions>(), Arg.Any<BuildTarget>()).Returns(manifest);

            await converter.ConvertAsync(new DCL.ABConverter.AssetBundleConverter.ConversionParams());

            // Ensure that web request is done
            webRequest.Received().Get(Arg.Is(exampleBaseURL));

            // Ensure that a directory is created for this asset
            directory.Received().CreateDirectory(Arg.Is(directoryName));

            // Ensure that the file is being written
            file.Received().WriteAllBytes(Arg.Is(assetPath.finalPath), Arg.Any<byte[]>());

            // Ensure that the asset is being imported
            assetDatabase.Received().ImportAsset(Arg.Is(assetPath.finalPath), Arg.Is(ImportAssetOptions.ForceUpdate));

            // Ensure that asset was marked for asset bundle build
            directory.Received().MarkFolderForAssetBundleBuild(assetPath.finalPath, assetPath.hash);

            // Ensure that asset bundles are being built
            buildPipeline.Received().BuildAssetBundles(Arg.Any<string>(), Arg.Any<BuildAssetBundleOptions>(), Arg.Any<BuildTarget>());

            // Ensure that visual tests are ran
            await editor.Received().TestConvertedAssetsAsync(Arg.Any<Environment>(), Arg.Any<ClientSettings>(), Arg.Any<List<AssetPath>>(), Arg.Any<IErrorReporter>());
        }

        [Test]
        public async Task GltfAssetIsProcessed()
        {
            var exampleAsset = new ContentServerUtils.MappingPair { file = "example.gltf", hash = "example" };
            var assetPath = new AssetPath(Config.GetDownloadPath(), exampleAsset);

            string directoryName = Path.GetDirectoryName(assetPath.finalPath);
            string exampleBaseURL = EXAMPLE_BASE_URL + exampleAsset.hash;

            directory.Exists(directoryName).Returns(false);
            webRequest.Get(exampleBaseURL).Returns(new DownloadHandlerMock());
            buildPipeline.BuildAssetBundles(Arg.Any<string>(), Arg.Any<BuildAssetBundleOptions>(), Arg.Any<BuildTarget>()).Returns(Substitute.For<IAssetBundleManifest>());
            var gltf = Substitute.For<IGltfImport>();

            gltfImporter.GetImporter(Arg.Any<AssetPath>(), Arg.Any<Dictionary<string, string>>(), Arg.Any<ShaderType>(), Arg.Any<BuildTarget>()).Returns(gltf);
            gltfImporter.ConfigureImporter(Arg.Any<string>(), Arg.Any<ContentMap[]>(), Arg.Any<string>(), Arg.Any<string>(), Arg.Any<ShaderType>(), Arg.Any<AnimationMethod>()).Returns(true);
            assetDatabase.LoadAssetAtPath<GameObject>(PathUtils.FullPathToAssetPath(assetPath.finalPath)).Returns(dummyGo);

            gltf.LoadingDone.Returns(true);
            gltf.LoadingError.Returns(false);
            gltf.TextureCount.Returns(0);
            gltf.MaterialCount.Returns(0);

            await converter.ConvertAsync(new DCL.ABConverter.AssetBundleConverter.ConversionParams());

            // Ensure that web request is done
            webRequest.Received().Get(Arg.Is(exampleBaseURL));

            // Ensure that a directory is created for this asset
            directory.Received().CreateDirectory(Arg.Is(directoryName));

            // Ensure that the file is being written
            file.Received().WriteAllBytes(Arg.Is(assetPath.finalPath), Arg.Any<byte[]>());

            // Ensure that the importer is being created
            gltfImporter.Received().GetImporter(Arg.Any<AssetPath>(), Arg.Any<Dictionary<string, string>>(), Arg.Any<ShaderType>(), Arg.Any<BuildTarget>());

            // Ensure that the gltf import is being loaded
            await gltf.Received().Load(Arg.Any<string>(), Arg.Any<ImportSettings>());

            // Ensure that the imported is properly configured
            gltfImporter.Received().ConfigureImporter(Arg.Any<string>(), Arg.Any<ContentMap[]>(), Arg.Any<string>(), Arg.Any<string>(), Arg.Any<ShaderType>(), Arg.Any<AnimationMethod>());

            // Ensure that asset was marked for asset bundle build
            directory.Received().MarkFolderForAssetBundleBuild(assetPath.finalPath, assetPath.hash);

            // Ensure that asset bundles are being built
            buildPipeline.Received().BuildAssetBundles(Arg.Any<string>(), Arg.Any<BuildAssetBundleOptions>(), Arg.Any<BuildTarget>());

            // Ensure that visual tests are ran
            await editor.Received().TestConvertedAssetsAsync(Arg.Any<Environment>(), Arg.Any<ClientSettings>(), Arg.Any<List<AssetPath>>(), Arg.Any<IErrorReporter>());
        }

        [Test]
        public async Task TextureIsExtractedFromGltf()
        {
            var hash = "hash";
            var exampleAsset = new ContentServerUtils.MappingPair { file = "example.gltf", hash = hash };
            var gltf = ConfigureGltf(exampleAsset);

            gltf.LoadingDone.Returns(true);
            gltf.LoadingError.Returns(false);
            gltf.TextureCount.Returns(1);
            gltf.MaterialCount.Returns(0);

            var exampleTexture = new Texture2D(1, 1);
            var textureName = "texture";
            exampleTexture.name = textureName;
            gltf.GetTexture(0).Returns(exampleTexture);

            await converter.ConvertAsync(new DCL.ABConverter.AssetBundleConverter.ConversionParams());

            var texturePath = $"{DOWNLOAD_FOLDER}{hash}{separator}Textures{separator}{textureName}.png";

            // Ensure that the texture was written correctly
            file.Received().WriteAllBytes(texturePath, Arg.Any<byte[]>());

            // Ensure that the texture was imported correclty
            assetDatabase.Received().ImportAsset(texturePath, Arg.Any<ImportAssetOptions>());
        }

        [Test]
        public async Task MaterialIsExtractedFromGltf()
        {
            var hash = "hash";
            var textureName = "texture";
            var materialName = "material";
            var materialPath = PathUtils.FixDirectorySeparator($"{DOWNLOAD_FOLDER}{hash}/Materials/{materialName}.mat");
            var texturePath = PathUtils.FixDirectorySeparator($"{DOWNLOAD_FOLDER}{hash}/Textures/{textureName}.png");

            var exampleAsset = new ContentServerUtils.MappingPair { file = "example.gltf", hash = hash };
            var gltf = ConfigureGltf(exampleAsset);

            gltf.LoadingDone.Returns(true);
            gltf.LoadingError.Returns(false);
            gltf.TextureCount.Returns(1);
            gltf.MaterialCount.Returns(1);

            // Configure Texture
            var exampleTexture = new Texture2D(1, 1);
            exampleTexture.name = textureName;
            gltf.GetTexture(0).Returns(exampleTexture);

            assetDatabase.LoadAssetAtPath<Texture2D>(texturePath).Returns(exampleTexture);

            // Configure material
            var material = new Material(Shader.Find("DCL/Universal Render Pipeline/Lit"));
            material.name = materialName;
            gltf.GetMaterial(0).Returns(material);
            material.SetTexture("_BaseMap", exampleTexture);

            // Ensure that a when the material asset is created, the new instance of the material is a copy
            assetDatabase.When(ad => ad.CreateAsset(Arg.Any<Material>(), Arg.Any<string>())).Do(c => Assert.AreNotEqual(c.Arg<Material>(), material));

            await converter.ConvertAsync(new DCL.ABConverter.AssetBundleConverter.ConversionParams());

            // Ensure that a material asset is created and the texture is set for this material
            assetDatabase.Received(1).CreateAsset(Arg.Is<Material>(m => m.GetTexture("_BaseMap")), Arg.Any<string>());
        }

        private IGltfImport ConfigureGltf(ContentServerUtils.MappingPair mappingPair)
        {
            var assetPath = new AssetPath(Config.GetDownloadPath(), mappingPair);
            string directoryName = Path.GetDirectoryName(assetPath.finalPath);
            string exampleBaseURL = EXAMPLE_BASE_URL + mappingPair.hash;
            directory.Exists(directoryName).Returns(false);
            webRequest.Get(exampleBaseURL).Returns(new DownloadHandlerMock());
            buildPipeline.BuildAssetBundles(Arg.Any<string>(), Arg.Any<BuildAssetBundleOptions>(), Arg.Any<BuildTarget>()).Returns(Substitute.For<IAssetBundleManifest>());
            var gltf = Substitute.For<IGltfImport>();
            gltfImporter.GetImporter(Arg.Any<AssetPath>(), Arg.Any<Dictionary<string, string>>(), Arg.Any<ShaderType>(), Arg.Any<BuildTarget>()).Returns(gltf);
            gltfImporter.ConfigureImporter(Arg.Any<string>(), Arg.Any<ContentMap[]>(), Arg.Any<string>(), Arg.Any<string>(), Arg.Any<ShaderType>(), Arg.Any<AnimationMethod>()).Returns(true);
            assetDatabase.LoadAssetAtPath<GameObject>(PathUtils.FullPathToAssetPath(assetPath.finalPath)).Returns(dummyGo);
            return gltf;
        }
    }
}
