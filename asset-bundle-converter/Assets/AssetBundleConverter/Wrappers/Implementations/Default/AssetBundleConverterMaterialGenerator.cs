using DCL.GLTFast.Wrappers;
using GLTFast;
using UnityEngine;

namespace AssetBundleConverter.Wrappers.Implementations.Default
{
    public class AssetBundleConverterMaterialGenerator : DecentralandMaterialGenerator
    {
        private static bool useSceneShader =>
#if UNITY_WEBGL
            false;
#else
            true;
#endif

        public AssetBundleConverterMaterialGenerator() : base(GetShaderName()) { }

        private static string GetShaderName() =>
            useSceneShader ? "DCL/Scene" : "DCL/Universal Render Pipeline/Lit";

        public override Material GenerateMaterial(int materialIndex, GLTFast.Schema.Material gltfMaterial, IGltfReadable gltf, bool pointsSupport = false)
        {
            var mat = base.GenerateMaterial(materialIndex, gltfMaterial, gltf, pointsSupport);

            if (useSceneShader)
            {
                // Enable Forward+ and soft shadows
                mat.EnableKeyword("_FORWARD_PLUS");
                mat.EnableKeyword("_ADDITIONAL_LIGHT_SHADOWS");
                mat.EnableKeyword("_MAIN_LIGHT_SHADOWS_CASCADE");
                mat.EnableKeyword("_SHADOWS_SOFT");
            }

            return mat;
        }
    }
}
