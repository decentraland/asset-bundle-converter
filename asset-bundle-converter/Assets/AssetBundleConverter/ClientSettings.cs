using DCL.ABConverter;
using System.IO;
using UnityEditor;
using UnityEngine;

namespace AssetBundleConverter
{
    public enum ShaderType
    {
        Dcl,
        GlTFast
    }

    public enum BuildPipelineType
    {
        Default,
        Scriptable
    }

    public class ClientSettings
        {
            /// <summary>
            /// if set to true, when conversion finishes, the working folder containing all downloaded assets will be deleted
            /// </summary>
            public bool deleteDownloadPathAfterFinished = false;

            /// <summary>
            /// If set to true, Asset Bundles will not be built at all, and only the asset dump will be performed.
            /// </summary>
            public bool dumpOnly = false;

            /// <summary>
            /// If set to true, Asset Bundle output folder will be checked, and existing bundles in that folder will be excluded from
            /// the conversion process.
            /// </summary>
            public bool skipAlreadyBuiltBundles = false;

            /// <summary>
            /// If set to true, the GLTF _Downloads folder and the Asset Bundles folder will be deleted at the beginning of the conversion
            /// </summary>
            public bool clearDirectoriesOnStart = true;

            /// <summary>
            /// Log verbosity.
            /// </summary>
            public bool verbose = false;

            /// <summary>
            /// Output folder for asset bundles, by default, they will be stored in Assets/../AssetBundles.
            /// </summary>
            public string finalAssetBundlePath = Config.ASSET_BUNDLES_PATH_ROOT + Path.DirectorySeparatorChar;

            /// <summary>
            /// Raw baseUrl using for asset dumping.
            /// </summary>
            public string baseUrl;

            public bool cleanAndExitOnFinish = true;
            public bool visualTest = false;
            public bool createAssetBundle = true;
            public int downloadBatchSize = 20;
            public float failingConversionTolerance = 0.05f;
            public bool placeOnScene = true;
            public string importOnlyEntity;

            public ShaderType shaderType = ShaderType.Dcl;

            public bool stripShaders = true;

            /// <summary>
            /// Whether to include all possible shader variants into the shader bundle
            /// </summary>
            public bool includeShaderVariants = false;

            public bool importGltf = true;
            public string targetHash;
            public Vector2Int? targetPointer = null;
            public bool reportErrors = false;
            public bool isWearable;
            public BuildTarget buildTarget = BuildTarget.WebGL;
            public BuildPipelineType BuildPipelineType = BuildPipelineType.Default;

            public ClientSettings Clone() { return MemberwiseClone() as ClientSettings; }

        }
}
