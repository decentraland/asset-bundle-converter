using DCL.GLTFast.Wrappers;
using DCL.Shaders;
using GLTFast;
using UnityEditor;
using UnityEngine;

namespace AssetBundleConverter.Wrappers.Implementations.Default
{
    public class AssetBundleConverterMaterialGenerator : DecentralandMaterialGenerator
    {
        public override Material GenerateMaterial(int materialIndex, GLTFast.Schema.Material gltfMaterial, IGltfReadable gltf, bool pointsSupport = false)
        {
            Material mat = base.GenerateMaterial(materialIndex, gltfMaterial, gltf, pointsSupport);

            // Enable Forward+ and soft shadows
            mat.EnableKeyword(ShaderUtils.FW_PLUS);
            mat.EnableKeyword(ShaderUtils.FW_PLUS_LIGHT_SHADOWS);
            mat.EnableKeyword(ShaderUtils.FW_PLUS_SHADOWS_CASCADE);
            mat.EnableKeyword(ShaderUtils.FW_PLUS_SHADOWS_SOFT);

            return mat;
        }
    }
}
