using System;
using UnityEngine;
using Object = UnityEngine.Object;

namespace AssetBundleConverter.LODsConverter.Utils
{
    public class ColliderGenerator
    {
        public static void GenerateColliders(GameObject model)
        {
            var meshFilters = model.GetComponentsInChildren<MeshFilter>();

            foreach (var filter in meshFilters)
            {
                if (filter.name.Contains("_collider", StringComparison.OrdinalIgnoreCase))
                    ConfigureColliders(filter.transform, filter);
            }

            var renderers = model.GetComponentsInChildren<Renderer>();

            foreach (var r in renderers)
            {
                if (r.name.Contains("_collider", StringComparison.OrdinalIgnoreCase))
                    Object.DestroyImmediate(r);
            }
        }

        private static void ConfigureColliders(Transform transform, MeshFilter filter)
        {
            if (filter != null)
            {
                Physics.BakeMesh(filter.sharedMesh.GetInstanceID(), false);
                filter.gameObject.AddComponent<MeshCollider>();
                Object.DestroyImmediate(filter.GetComponent<MeshRenderer>());
            }

            foreach (Transform child in transform)
            {
                var f = child.gameObject.GetComponent<MeshFilter>();
                ConfigureColliders(child, f);
            }
        }
    }
}