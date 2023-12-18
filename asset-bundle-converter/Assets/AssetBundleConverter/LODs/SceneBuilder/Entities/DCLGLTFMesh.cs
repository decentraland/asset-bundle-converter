using AssetBundleConverter.LODs.JsonParsing;
using System.Collections.Generic;
using UnityEditor;
using UnityEngine;

namespace AssetBundleConverter.LODs
{
    public class DCLGLTFMesh : DCLMesh
    {

        private string src;

        public DCLGLTFMesh(string src)
        {
            this.src = src;
        }

        public override void InstantiateMesh(Transform parent, DCLMaterial material, Dictionary<string, string> contentTable)
        {
            if (contentTable.TryGetValue(src, out string texturePath))
            {
                GameObject prefab = AssetDatabase.LoadAssetAtPath<GameObject>(texturePath);
                GameObject container = Object.Instantiate(prefab, parent, false);
                container.name = "GLTFMesh";
            }
        }
    }
}
