using DCL.GLTFast.Wrappers;

namespace AssetBundleConverter.Wrappers.Implementations.Default
{
    public class AssetBundleConverterMaterialGenerator : DecentralandMaterialGenerator
    {
        public AssetBundleConverterMaterialGenerator() : base(GetShaderName()) { }

        private static string GetShaderName()
        {
            #if UNITY_WEBGL
            return "DCL/Universal Render Pipeline/Lit";
            #else
            return "DCL/Scene";
            #endif
        }
    }
}
