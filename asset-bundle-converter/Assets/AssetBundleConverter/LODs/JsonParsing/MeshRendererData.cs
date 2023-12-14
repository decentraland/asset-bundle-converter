// unset:none
using System;
using System.Collections.Generic;
using Unity.Plastic.Newtonsoft.Json;
using UnityEngine;
using Utility.Primitives;

namespace AssetBundleConverter.LODs.JsonParsing
{
    [Serializable]
    public class MeshRendererData : ComponentData
    {
        public DCLMesh mesh;
    }

    [JsonConverter(typeof(MeshRendererDataConverter))]
    [Serializable]
    public abstract class DCLMesh
    {
        public abstract void InstantiateMesh(Transform parent, DCLMaterial material, Dictionary<string, string> contentTable);
    }



}
