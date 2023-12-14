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
                GameObject container = GameObject.Instantiate(AssetDatabase.LoadAssetAtPath<GameObject>(texturePath));
                container.name = "GLTFMesh";
                container.transform.SetParent(parent);
                container.transform.localPosition = Vector3.zero;
                container.transform.localScale = Vector3.one;
                container.transform.localRotation = Quaternion.identity;
            }
        }
    }
}
