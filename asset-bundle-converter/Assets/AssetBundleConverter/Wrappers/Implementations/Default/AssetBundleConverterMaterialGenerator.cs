using DCL.GLTFast.Wrappers;
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
                foreach (var keywordName in mat.shaderKeywords)
                {
                    mat.DisableKeyword(keywordName);
                }

                // Enable Forward+ and soft shadows
                mat.EnableKeyword("_FORWARD_PLUS");
                mat.EnableKeyword("_NORMALMAP");
                mat.EnableKeyword("_EMISSION");
                mat.EnableKeyword("_ADDITIONAL_LIGHT_SHADOWS");
                mat.EnableKeyword("_MAIN_LIGHT_SHADOWS_CASCADE");
                mat.EnableKeyword("_SHADOWS_SOFT");
            }

            return mat;
        }
    }
}
