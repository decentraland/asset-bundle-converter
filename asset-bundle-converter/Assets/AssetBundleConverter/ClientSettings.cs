using System.Collections.Generic;
using System.IO;
using DCL.ABConverter;
using GLTFast;
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
            /// animation method used to force the legacy animation system or not from CLI
            /// </summary>
            public AnimationMethod AnimationMethod = AnimationMethod.Legacy;

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
        public float failingConversionTolerance = 1f;
            public bool placeOnScene = false;
            public string importOnlyEntity;

            public ShaderType shaderType = ShaderType.Dcl;

            public bool stripShaders = true;

            /// <summary>
            /// Whether to include all possible shader variants into the shader bundle
            /// </summary>
            public bool includeShaderVariants = false;

            public bool importGltf = true;

            /// <summary>
            /// Enable half-precision (16-bit) vertex positions for small meshes (bounds less than 16m).
            /// This reduces position data memory by 50% (12 bytes -> 6 bytes per vertex).
            /// </summary>
            public bool useHalfPrecisionPositions = true;

            public string targetHash;
            public Vector2Int? targetPointer = null;

            /// <summary>
            /// Content hashes whose asset bundles are already available at the canonical CDN
            /// location. GLTF/GLB and BIN entries whose hash appears here are skipped during
            /// the asset-bundle build step; textures are intentionally not filtered because
            /// they can still be referenced from non-cached GLTFs.
            /// </summary>
            public HashSet<string> cachedHashes = new HashSet<string>();

            /// <summary>
            /// Content hashes whose glb/gltf bytes the consumer-server determined are
            /// unconvertible — either because the glb references texture/buffer URIs that
            /// are not in the entity's content map, or because the glb bytes are
            /// structurally malformed. These hashes are dropped from gltfPaths and
            /// bufferPaths before any download or import attempt, so no bundle is produced
            /// for them. Distinct from <see cref="cachedHashes"/>: cached hashes correspond
            /// to existing canonical bundles upstream, whereas skipped hashes have no
            /// bundle anywhere — the asset is simply absent from the output.
            /// </summary>
            public HashSet<string> skippedHashes = new HashSet<string>();

            /// <summary>
            /// Per-asset deps digests keyed by asset content hash. When non-empty, each
            /// GLB/GLTF bundle is named `{hash}_{depsDigestByHash[hash]}_{target}` instead
            /// of `{hash}_{target}` so its canonical path factors in the specific textures
            /// and buffers that glb references — two scenes sharing a glb source hash AND
            /// its referenced deps produce identical canonical paths (cross-scene reuse).
            /// BIN and texture bundles are unchanged (they're leaves with no inbound dep
            /// refs from their own bundle).
            /// Populated from the CLI `-depsDigestsFile` flag.
            /// </summary>
            public Dictionary<string, string> depsDigestByHash = new Dictionary<string, string>();
            public bool reportErrors = false;
            public bool isWearable;
            public BuildTarget buildTarget = BuildTarget.WebGL;
            public BuildPipelineType BuildPipelineType = BuildPipelineType.Default;

            public ClientSettings Clone() { return MemberwiseClone() as ClientSettings; }

        }
}
