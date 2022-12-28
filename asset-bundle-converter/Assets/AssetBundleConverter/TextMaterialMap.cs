using UnityEngine;

namespace AssetBundleConverter
{
    public class TexMaterialMap
    {
        public Material Material { get; set; }
        public string Property { get; set; }
        public bool IsNormalMap { get; set; }

        public TexMaterialMap(Material material, string property, bool isNormalMap)
        {
            Material = material;
            Property = property;
            IsNormalMap = isNormalMap;
        }
    }
}
