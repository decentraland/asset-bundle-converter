using AssetBundleConverter.Wrappers.Interfaces;
using DCL;
using DCL.ABConverter;
using NSubstitute;
using NUnit.Framework;
using System;
using System.Collections.Generic;
using System.IO;
using System.Threading.Tasks;
using UnityEditor;
using UnityEngine;

namespace AssetBundleConverter.Tests
{
    [TestFixture]
    [Category("EditModeCI")]
    public class AssetBundleConverterShould
    {
        private const string EXAMPLE_AB_PATH = "Example/AssetBundle/";
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

        [SetUp]
        public void Setup()
        {
            directory = Substitute.For<IDirectory>();
            file = Substitute.For<IFile>();
            assetDatabase = Substitute.For<IAssetDatabase>();
            webRequest = Substitute.For<IWebRequest>();
            buildPipeline = Substitute.For<IBuildPipeline>();
            gltfImporter = Substitute.For<IGltfImporter>();
            editor = Substitute.For<IEditor>();
            errorReporter = Substitute.For<IErrorReporter>();
            abLogger = Substitute.For<IABLogger>();

            //Any error or exit code should make any test fail unless its explicitly required
            errorReporter.When(x => x.ReportError(Arg.Any<string>(), Arg.Any<ClientSettings>())).Do(x => throw new Exception("There was an unexpected error: " + x.Arg<string>()));
            errorReporter.When(x => x.ReportException(Arg.Any<ConversionException>())).Do(x => throw x.Arg<ConversionException>().originalException);
            editor.When(x => x.Exit(Arg.Any<int>())).Do(x => ThrowIfExitCodeIsNotZero(x.Arg<int>()));

            environment = new Environment(directory, file, assetDatabase, webRequest, buildPipeline, gltfImporter, editor, abLogger, errorReporter);

            var clientSettings = new ClientSettings
            {
                finalAssetBundlePath = EXAMPLE_AB_PATH,
                baseUrl = EXAMPLE_BASE_URL,
            };

            converter = new DCL.ABConverter.AssetBundleConverter(environment, clientSettings);
        }

        private void ThrowIfExitCodeIsNotZero(int exitCode)
        {
            if (exitCode != 0) throw new Exception("Exit code " + exitCode);
        }

        [Test]
        public async Task LoadVisualSceneOnStart()
        {
            await converter.ConvertAsync(new List<ContentServerUtils.MappingPair>());

            await editor.Received().LoadVisualTestSceneAsync();
        }

        [Test]
        public async Task InitializeDirectories()
        {
            await converter.ConvertAsync(new List<ContentServerUtils.MappingPair>());

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

            await converter.ConvertAsync(new List<ContentServerUtils.MappingPair> { exampleAsset });

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
    }
}
