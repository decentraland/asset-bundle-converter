using System;
using UnityEditor;
using UnityEngine;
using Object = UnityEngine.Object;

public class CustomLODFBXPostProcessor : AssetPostprocessor
{
    private void GenerateColliders(GameObject model)
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

    private void ConfigureColliders(Transform transform, MeshFilter filter)
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

    private void OnPostprocessModel(GameObject model)
    {
        if (context.assetPath.EndsWith(".fbx") && model.name.EndsWith("_0"))
        {
            var renderers = model.GetComponentsInChildren<SkinnedMeshRenderer>();
            foreach (var renderer in renderers)
            {
                if (ArrayContainsNaN(renderer.sharedMesh.bindposes))
                    renderer.gameObject.SetActive(false);
            }
            GenerateColliders(model);
        }
    }

    private bool MatrixContainsNaN(Matrix4x4 matrix)
    {
        for (int i = 0; i < 16; i++)
        {
            if (float.IsNaN(matrix[i]))
            {
                return true;
            }
        }

        return false;
    }

    private bool ArrayContainsNaN(Matrix4x4[] matrices)
    {
        foreach (var matrix in matrices)
        {
            if (MatrixContainsNaN(matrix))
            {
                return true;
            }
        }

        return false;
    }
    
}