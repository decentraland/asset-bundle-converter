using AssetBundleConverter.Wrappers.Implementations.Default;
using AssetBundleConverter.Wrappers.Interfaces;
using DCL;
using SystemWrappers = AssetBundleConverter.Wrappers.Implementations.Default.SystemWrappers;

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

        public static Environment CreateWithDefaultImplementations()
        {
            var database = new UnityEditorWrappers.AssetDatabase();

            return new (
                directory: new DCL.SystemWrappers.Directory(),
                file: new SystemWrappers.File(),
                assetDatabase: database,
                webRequest: new UnityEditorWrappers.WebRequest(),
                buildPipeline: new UnityEditorWrappers.BuildPipeline(),
                gltfImporter: new DefaultGltfImporter(database),
                editor: new AssetBundleEditor(),
                logger: new ABLogger("[AssetBundleConverter]"),
                errorReporter: new ErrorReporter()
            );
        }
    }
}
