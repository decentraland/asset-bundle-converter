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
        /// Generates LODs for all meshes in a GameObject hierarchy.
        /// </summary>
        /// <param name="gameObject">The root GameObject to process</param>
        /// <param name="maxLODCount">Maximum number of LOD levels to generate</param>
        /// <returns>Number of meshes processed</returns>
        public static int GenerateLODsForGameObject(GameObject gameObject, int maxLODCount = DEFAULT_MAX_LOD_COUNT)
        {
            if (gameObject == null)
            {
                Debug.LogWarning("MeshLODGenerator: GameObject is null, skipping LOD generation");
                return 0;
            }

            if (maxLODCount <= 0)
            {
                Debug.LogWarning("MeshLODGenerator: maxLODCount is 0 or negative, skipping LOD generation");
                return 0;
            }

            MeshFilter[] meshFilters = gameObject.GetComponentsInChildren<MeshFilter>(true);
            int meshesProcessed = 0;

            foreach (MeshFilter meshFilter in meshFilters)
            {
                if (GenerateLODsForMesh(meshFilter.sharedMesh, maxLODCount))
                {
                    meshesProcessed++;
                }
            }

            return meshesProcessed;
        }

        /// <summary>
        /// Generates LODs for a single mesh.
        /// </summary>
        /// <param name="mesh">The mesh to generate LODs for</param>
        /// <param name="maxLODCount">Maximum number of LOD levels to generate</param>
        /// <returns>True if LODs were generated successfully</returns>
        public static bool GenerateLODsForMesh(Mesh mesh, int maxLODCount = DEFAULT_MAX_LOD_COUNT)
        {
            if (mesh == null)
            {
                return false;
            }

            if (maxLODCount <= 0)
            {
                return false;
            }

            // Skip if the mesh already has LODs
            if (mesh.lodCount >= 2)
            {
                Debug.Log($"MeshLODGenerator: Mesh '{mesh.name}' already has {mesh.lodCount} LOD levels, skipping");
                return false;
            }

            try
            {
                int originalVertices = mesh.vertexCount;
                int originalTriangles = mesh.triangles.Length / 3;

                MeshLodUtility.GenerateMeshLods(mesh, maxLODCount);

                Debug.Log($"MeshLODGenerator: Generated {mesh.lodCount} LODs for mesh '{mesh.name}' " +
                         $"(verts: {originalVertices:N0}, tris: {originalTriangles:N0})");

                EditorUtility.SetDirty(mesh);
                return true;
            }
            catch (System.Exception e)
            {
                Debug.LogError($"MeshLODGenerator: Failed to generate LODs for mesh '{mesh.name}': {e.Message}");
                return false;
            }
        }

        /// <summary>
        /// Generates LODs for all renderers in a GameObject hierarchy.
        /// This method handles both MeshRenderers (via MeshFilter) and SkinnedMeshRenderers.
        /// </summary>
        /// <param name="gameObject">The root GameObject to process</param>
        /// <param name="maxLODCount">Maximum number of LOD levels to generate</param>
        /// <returns>Number of meshes processed</returns>
        public static int GenerateLODsForRenderers(GameObject gameObject, int maxLODCount = DEFAULT_MAX_LOD_COUNT)
        {
            if (gameObject == null)
            {
                Debug.LogWarning("MeshLODGenerator: GameObject is null, skipping LOD generation");
                return 0;
            }

            if (maxLODCount <= 0)
            {
                Debug.LogWarning("MeshLODGenerator: maxLODCount is 0 or negative, skipping LOD generation");
                return 0;
            }

            int meshesProcessed = 0;

            // Process MeshFilters (for MeshRenderers)
            MeshFilter[] meshFilters = gameObject.GetComponentsInChildren<MeshFilter>(true);
            foreach (MeshFilter meshFilter in meshFilters)
            {
                // Skip collider meshes
                if (meshFilter.name.Contains("_collider", System.StringComparison.OrdinalIgnoreCase))
                    continue;

                if (GenerateLODsForMesh(meshFilter.sharedMesh, maxLODCount))
                {
                    meshesProcessed++;
                }
            }

            // Process SkinnedMeshRenderers
            SkinnedMeshRenderer[] skinnedRenderers = gameObject.GetComponentsInChildren<SkinnedMeshRenderer>(true);
            foreach (SkinnedMeshRenderer skinnedRenderer in skinnedRenderers)
            {
                if (GenerateLODsForMesh(skinnedRenderer.sharedMesh, maxLODCount))
                {
                    meshesProcessed++;
                }
            }

            return meshesProcessed;
        }

        /// <summary>
        /// Extracts each LOD level from a mesh and saves them as separate .mesh files.
        /// The mesh must already have LODs generated via GenerateLODsForMesh.
        /// </summary>
        /// <param name="sourceMesh">The mesh with LODs to extract</param>
        /// <param name="outputFolder">The folder to save the extracted mesh files</param>
        /// <returns>List of paths to the created mesh files</returns>
        public static List<string> ExtractLODMeshesToFiles(Mesh sourceMesh, string outputFolder)
        {
            List<string> generatedFiles = new List<string>();

            if (sourceMesh == null || sourceMesh.lodCount == 0)
            {
                return generatedFiles;
            }

            string baseName = sourceMesh.name;
            int lodCount = sourceMesh.lodCount;
            int subMeshCount = sourceMesh.subMeshCount;

            for (int lodIndex = 0; lodIndex < lodCount; lodIndex++)
            {
                // Create a clean new mesh for this LOD level
                Mesh lodMesh = new Mesh();
                lodMesh.name = $"{baseName}_LOD{lodIndex}";

                // Copy vertex data
                lodMesh.vertices = sourceMesh.vertices;
                lodMesh.normals = sourceMesh.normals;
                lodMesh.tangents = sourceMesh.tangents;
                lodMesh.colors = sourceMesh.colors;
                lodMesh.colors32 = sourceMesh.colors32;
                lodMesh.uv = sourceMesh.uv;
                lodMesh.uv2 = sourceMesh.uv2;

                // Set submesh count
                lodMesh.subMeshCount = subMeshCount;

                // Set triangles for this specific LOD level only
                int totalTriangles = 0;
                for (int subMeshIndex = 0; subMeshIndex < subMeshCount; subMeshIndex++)
                {
                    int[] triangles = sourceMesh.GetTriangles(subMeshIndex, lodIndex, false);
                    lodMesh.SetTriangles(triangles, subMeshIndex, false);
                    totalTriangles += triangles.Length / 3;
                }

                lodMesh.RecalculateBounds();

                // Save as separate .mesh file
                string lodFileName = $"{baseName}_LOD{lodIndex}.mesh";
                string lodPath = Path.Combine(outputFolder, lodFileName).Replace("\\", "/");

                AssetDatabase.CreateAsset(lodMesh, lodPath);
                generatedFiles.Add(lodPath);

                float reduction = sourceMesh.vertexCount > 0
                    ? (1 - (float)lodMesh.vertexCount / sourceMesh.vertexCount) * 100
                    : 0;

                Debug.Log($"  Extracted LOD{lodIndex}:");
                Debug.Log($"    Path: {lodPath}");
                Debug.Log($"    Vertices: {lodMesh.vertexCount:N0}");
                Debug.Log($"    Triangles: {totalTriangles:N0}");
                Debug.Log($"    Reduction: {reduction:F1}%");
            }

            // Mark the source mesh as dirty to save the LOD data
            EditorUtility.SetDirty(sourceMesh);

            return generatedFiles;
        }
    }
}

