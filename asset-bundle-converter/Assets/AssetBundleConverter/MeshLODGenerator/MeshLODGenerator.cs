using System.Collections.Generic;
using System.IO;
using UnityEngine;
using UnityEditor;

namespace AssetBundleConverter.Editor
{
    /// <summary>
    /// Utility class to generate mesh LODs programmatically.
    /// Uses Unity's MeshLodUtility to simplify meshes.
    /// </summary>
    public static class MeshLODGenerator
    {
        /// <summary>
        /// Default maximum number of LOD levels to generate.
        /// </summary>
        public const int DEFAULT_MAX_LOD_COUNT = 5;

        /// <summary>
        /// Holds information about a mesh source (either MeshFilter or SkinnedMeshRenderer).
        /// </summary>
        public struct MeshSource
        {
            public Mesh sharedMesh;
            public GameObject gameObject;
            public bool isSkinnedMesh;

            public MeshSource(MeshFilter mf)
            {
                sharedMesh = mf.sharedMesh;
                gameObject = mf.gameObject;
                isSkinnedMesh = false;
            }

            public MeshSource(SkinnedMeshRenderer smr)
            {
                sharedMesh = smr.sharedMesh;
                gameObject = smr.gameObject;
                isSkinnedMesh = true;
            }
        }

        /// <summary>
        /// Gets all mesh sources (MeshFilter and SkinnedMeshRenderer) from a GameObject hierarchy.
        /// Filters out meshes with "_collider" in their name.
        /// </summary>
        /// <param name="gameObject">The root GameObject to search</param>
        /// <returns>List of MeshSource structs</returns>
        public static List<MeshSource> GetAllMeshSources(GameObject gameObject)
        {
            var meshSources = new List<MeshSource>();

            if (gameObject == null)
                return meshSources;

            // Get MeshFilters
            MeshFilter[] meshFilters = gameObject.GetComponentsInChildren<MeshFilter>(true);
            foreach (var mf in meshFilters)
            {
                // Skip collider meshes
                if (mf.sharedMesh != null && mf.sharedMesh.name.Contains("_collider"))
                    continue;

                meshSources.Add(new MeshSource(mf));
            }

            // Get SkinnedMeshRenderers
            SkinnedMeshRenderer[] skinnedMeshRenderers = gameObject.GetComponentsInChildren<SkinnedMeshRenderer>(true);
            foreach (var smr in skinnedMeshRenderers)
            {
                // Skip collider meshes
                if (smr.sharedMesh != null && smr.sharedMesh.name.Contains("_collider"))
                    continue;

                meshSources.Add(new MeshSource(smr));
            }

            return meshSources;
        }

        /// <summary>
        /// Generates LODs for all meshes in a GameObject hierarchy.
        /// Processes both MeshFilter and SkinnedMeshRenderer components.
        /// Skips meshes with "_collider" in their name.
        /// </summary>
        /// <param name="gameObject">The root GameObject to process</param>
        /// <param name="maxLODCount">Maximum number of LOD levels to generate</param>
        /// <returns>Number of meshes processed</returns>
        public static int GenerateLODsForGameObject(GameObject gameObject, int maxLODCount = DEFAULT_MAX_LOD_COUNT)
        {
            if (gameObject == null) return 0;

            int meshesProcessed = 0;
            var processedMeshes = new HashSet<Mesh>();
            var meshSources = GetAllMeshSources(gameObject);

            foreach (var meshSource in meshSources)
            {
                if (meshSource.sharedMesh == null) continue;
                if (processedMeshes.Contains(meshSource.sharedMesh)) continue;

                processedMeshes.Add(meshSource.sharedMesh);
                GenerateLODsForMesh(meshSource.sharedMesh, maxLODCount);
                meshesProcessed++;
            }

            return meshesProcessed;
        }

        /// <summary>
        /// Generates LODs for a single mesh.
        /// </summary>
        /// <param name="mesh">The mesh to generate LODs for</param>
        /// <param name="maxLODCount">Maximum number of LOD levels to generate</param>
        public static void GenerateLODsForMesh(Mesh mesh, int maxLODCount = DEFAULT_MAX_LOD_COUNT)
        {
            if (mesh == null)
                return;

            if (maxLODCount <= 0)
                return;

            try
            {
                int originalVertices = mesh.vertexCount;
                int originalTriangles = mesh.triangles.Length / 3;

                MeshLodUtility.GenerateMeshLods(mesh, maxLODCount);

                Debug.Log($"MeshLODGenerator: Generated {mesh.lodCount} LODs for mesh '{mesh.name}' " +
                         $"(verts: {originalVertices:N0}, tris: {originalTriangles:N0})");

                EditorUtility.SetDirty(mesh);
            }
            catch (System.Exception e)
            {
                Debug.LogError($"MeshLODGenerator: Failed to generate LODs for mesh '{mesh.name}': {e.Message}");
            }
        }
    }
}

