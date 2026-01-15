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
        public readonly BuildPipelineType buildPipelineType;

        /// <summary>
        /// The ImageDuplicateAnalyzer for detecting duplicate textures via CRC/hash checks.
        /// Must be initialized via InitializeImageDuplicateAnalyzer before use.
        /// </summary>
        public ImageDuplicateAnalyzer imageDuplicateAnalyzer { get; private set; }

        /// <summary>
        /// The InitialSceneStateGenerator instance for this environment.
        /// Must be initialized via InitializeSceneStateGenerator before use.
        /// </summary>
        public InitialSceneStateGenerator.InitialSceneStateGenerator sceneStateGenerator { get; private set; }

        internal Environment(IDirectory directory, IFile file, IAssetDatabase assetDatabase, IWebRequest webRequest, IBuildPipeline buildPipeline, IGltfImporter gltfImporter, IEditor editor, IABLogger logger, IErrorReporter errorReporter,
            BuildPipelineType buildPipelineType)
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
            this.buildPipelineType = buildPipelineType;
        }

        /// <summary>
        /// Initializes the ImageDuplicateAnalyzer for this environment.
        /// </summary>
        /// <param name="enabled">Whether duplicate analysis should be enabled</param>
        /// <param name="downloadedPath">Base path where downloaded assets are stored</param>
        public void InitializeImageDuplicateAnalyzer(bool enabled, string downloadedPath)
        {
            imageDuplicateAnalyzer = new ImageDuplicateAnalyzer(
                enabled,
                downloadedPath,
                file,
                directory,
                assetDatabase,
                logger);
        }

        /// <summary>
        /// Initializes the InitialSceneStateGenerator for this environment with the given entity DTO.
        /// This checks compatibility once and caches the result.
        /// </summary>
        /// <param name="entityDTO">The entity DTO containing scene information</param>
        /// <returns>The initialized generator (also accessible via sceneStateGenerator property)</returns>
        public void InitializeSceneStateGenerator(ContentServerUtils.EntityMappingsDTO entityDTO)
        {
            sceneStateGenerator = new InitialSceneStateGenerator.InitialSceneStateGenerator(this, entityDTO);
        }

        public static Environment CreateWithDefaultImplementations(BuildPipelineType buildPipelineType)
        {
            var database = new UnityEditorWrappers.AssetDatabase();

            IBuildPipeline pipeline =
                buildPipelineType == BuildPipelineType.Scriptable ? new ScriptableBuildPipeline() : new UnityEditorWrappers.BuildPipeline();

            return new (
                directory: new DCL.SystemWrappers.Directory(),
                file: new SystemWrappers.File(),
                assetDatabase: database,
                webRequest: new UnityEditorWrappers.WebRequest(),
                buildPipeline: pipeline,
                gltfImporter: new DefaultGltfImporter(database),
                editor: new AssetBundleEditor(),
                logger: new ABLogger("[AssetBundleConverter]"),
                errorReporter: new ErrorReporter(),
                buildPipelineType: buildPipelineType
            );
        }
    }
}
