using AssetBundleConverter.LODs.JsonParsing;
using System.Collections.Generic;
using UnityEngine;
using Utility.Primitives;

namespace AssetBundleConverter.LODs
{
    public abstract class DCLPrimitiveMesh : DCLMesh
    {
        protected abstract Mesh GetMesh();
        public override void InstantiateMesh(Transform parent, DCLMaterial material, Dictionary<string, string> contentTable)
        {
            GameObject container = new GameObject();
            container.name = "PrimitiveMesh";
            container.transform.SetParent(parent);
            container.transform.localPosition = Vector3.zero;
            container.transform.localScale = Vector3.one;
            container.transform.localRotation = Quaternion.identity;

            MeshFilter meshFilter = container.AddComponent<MeshFilter>();
            meshFilter.mesh = GetMesh();

            MeshRenderer renderer = container.AddComponent<MeshRenderer>();
            renderer.material = material.GetMaterial(contentTable);
        }
    }

    public class Box : DCLPrimitiveMesh
    {
        public float[] uvs;

        protected override Mesh GetMesh() =>
            BoxFactory.Create(uvs);

    }

    public class Cylinder : DCLPrimitiveMesh
    {
        public int radiusTop;
        public int radiusBottom;

        protected override Mesh GetMesh() =>
            CylinderVariantsFactory.Create(radiusTop,radiusBottom);

    }
}
