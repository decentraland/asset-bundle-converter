using DCL.GLTFast.Wrappers;
using DCL.Shaders;
using GLTFast;
using UnityEditor;
using UnityEngine;

namespace AssetBundleConverter.Wrappers.Implementations.Default
{
    public class AssetBundleConverterMaterialGenerator : DecentralandMaterialGenerator
    {
        private readonly bool useSceneShader;

        public AssetBundleConverterMaterialGenerator(bool useSceneShader) : base(GetShaderName(useSceneShader))
        {
            this.useSceneShader = useSceneShader;
        }

        public static bool UseNewShader(BuildTarget buildTarget) =>
            buildTarget != BuildTarget.WebGL;

        private static string GetShaderName(bool useSceneShader) =>
            useSceneShader ? "DCL/Scene" : "DCL/Universal Render Pipeline/Lit";

        public override Material GenerateMaterial(int materialIndex, GLTFast.Schema.Material gltfMaterial, IGltfReadable gltf, bool pointsSupport = false)
        {
            var mat = base.GenerateMaterial(materialIndex, gltfMaterial, gltf, pointsSupport);

            if (useSceneShader)
            {
                // Enable Forward+ and soft shadows
                mat.EnableKeyword(ShaderUtils.FW_PLUS);
                mat.EnableKeyword(ShaderUtils.FW_PLUS_LIGHT_SHADOWS);
                mat.EnableKeyword(ShaderUtils.FW_PLUS_SHADOWS_CASCADE);
                mat.EnableKeyword(ShaderUtils.FW_PLUS_SHADOWS_SOFT);
            }

            return mat;
        }
    }
}
