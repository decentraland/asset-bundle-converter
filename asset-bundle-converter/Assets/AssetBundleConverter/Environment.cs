using AssetBundleConverter.Wrappers.Implementations.Default;
using AssetBundleConverter.Wrappers.Interfaces;
using DCL;
using System;
using System.Threading.Tasks;
using UnityEditor.SceneManagement;

namespace AssetBundleConverter
{
    public class Environment
    {
        private const string VISUAL_TEST_SCENE = "Assets/AssetBundleConverter/VisualTestScene.unity";

        public readonly IDirectory directory;
        public readonly IFile file;
        public readonly IAssetDatabase assetDatabase;
        public readonly IWebRequest webRequest;
        public readonly IBuildPipeline buildPipeline;
        public readonly IEditor editor;
        public readonly IGltfImporter gltfImporter;

        internal Environment(IDirectory directory, IFile file, IAssetDatabase assetDatabase, IWebRequest webRequest, IBuildPipeline buildPipeline, IGltfImporter gltfImporter, IEditor editor)
        {
            this.directory = directory;
            this.file = file;
            this.assetDatabase = assetDatabase;
            this.webRequest = webRequest;
            this.buildPipeline = buildPipeline;
            this.gltfImporter = gltfImporter;
            this.editor = editor;
        }

        public static Environment CreateWithDefaultImplementations() =>
            new (
                directory: new SystemWrappers.Directory(),
                file: new SystemWrappers.File(),
                assetDatabase: new UnityEditorWrappers.AssetDatabase(),
                webRequest: new UnityEditorWrappers.WebRequest(),
                buildPipeline: new UnityEditorWrappers.BuildPipeline(),
                gltfImporter: new DefaultGltfImporter(),
                editor: new AssetBundleEditor()
            );

        // TODO: Replace with substitutes, send this factory to another class
        /*public static Environment CreateWithMockImplementations()
        {
            var file = new Mocked.File();

            return new Environment
            (
                directory: new Mocked.Directory(),
                file: file,
                assetDatabase: new Mocked.AssetDatabase(file),
                webRequest: new Mocked.WebRequest(),
                buildPipeline: new UnityEditorWrappers.BuildPipeline()
            );
        }*/

        public async Task LoadVisualTestSceneAsync()
        {
            var scene = EditorSceneManager.OpenScene(VISUAL_TEST_SCENE, OpenSceneMode.Single);
            await WaitUntilAsync(() => scene.isLoaded);
        }

        private static async Task WaitUntilAsync(Func<bool> predicate, int sleep = 50)
        {
            while (!predicate()) { await Task.Delay(sleep); }
        }
    }
}
