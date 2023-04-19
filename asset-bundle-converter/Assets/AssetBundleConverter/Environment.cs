using AssetBundleConverter.Wrappers.Implementations.Default;
using AssetBundleConverter.Wrappers.Interfaces;
using DCL;

namespace AssetBundleConverter
{
    public class Environment
    {
        public readonly IDirectory directory;
        public readonly IFile file;
        public readonly IAssetDatabase assetDatabase;
        public readonly IWebRequest webRequest;
        public readonly IBuildPipeline buildPipeline;
        public readonly IEditor editor;
        public readonly IGltfImporter gltfImporter;
        public readonly IABLogger logger;
        public readonly IErrorReporter errorReporter;

        internal Environment(IDirectory directory, IFile file, IAssetDatabase assetDatabase, IWebRequest webRequest, IBuildPipeline buildPipeline, IGltfImporter gltfImporter, IEditor editor, IABLogger logger, IErrorReporter errorReporter)
        {
            this.directory = directory;
            this.file = file;
            this.assetDatabase = assetDatabase;
            this.webRequest = webRequest;
            this.buildPipeline = buildPipeline;
            this.gltfImporter = gltfImporter;
            this.editor = editor;
            this.logger = logger;
            this.errorReporter = errorReporter;
        }

        public static Environment CreateWithDefaultImplementations() =>
            new (
                directory: new SystemWrappers.Directory(),
                file: new SystemWrappers.File(),
                assetDatabase: new UnityEditorWrappers.AssetDatabase(),
                webRequest: new UnityEditorWrappers.WebRequest(),
                buildPipeline: new UnityEditorWrappers.BuildPipeline(),
                gltfImporter: new DefaultGltfImporter(),
                editor: new AssetBundleEditor(),
                logger: new ABLogger("[AssetBundleConverter]"),
                errorReporter: new ErrorReporter()
            );
    }
}
