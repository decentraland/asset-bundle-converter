using System;
using System.Collections.Generic;
using Unity.Collections;
using Unity.Collections.LowLevel.Unsafe;
using UnityEngine;
using UnityEngine.Rendering;

namespace AssetBundleConverter.MeshOptimization
{
    /// <summary>
    /// Utility class for optimizing mesh vertex data by converting to half-precision formats.
    /// - Positions: Only converted to Float16 if mesh bounds are within 16m (precision requirement)
    /// - Normals, Tangents, Colors, UVs: Always converted to Float16 (always safe)
    /// </summary>
    public static class MeshOptimizer
    {
        /// <summary>
        /// Maximum bounding box size in any dimension for half-precision positions.
        /// At 16m, half-float precision is approximately 1.6cm which is acceptable for most content.
        /// </summary>
        public const float MAX_HALF_PRECISION_BOUNDS = 16f;

        /// <summary>
        /// Checks if a mesh is eligible for optimization.
        /// </summary>
        public static bool IsEligibleForOptimization(Mesh mesh)
        {
            if (mesh == null)
                return false;

            if (mesh.vertexCount == 0)
                return false;

            // Check if mesh is already optimized (normals already Float16)
            var attributes = mesh.GetVertexAttributes();
            foreach (var attr in attributes)
            {
                if (attr.attribute == VertexAttribute.Normal &&
                    attr.format == VertexAttributeFormat.Float16)
                    return false; // Already optimized
            }

            return true;
        }

        /// <summary>
        /// Checks if positions can use half-precision (bounds within 16m).
        /// </summary>
        public static bool CanUseHalfPrecisionPositions(Mesh mesh)
        {
            var bounds = mesh.bounds;
            return bounds.size.x <= MAX_HALF_PRECISION_BOUNDS &&
                   bounds.size.y <= MAX_HALF_PRECISION_BOUNDS &&
                   bounds.size.z <= MAX_HALF_PRECISION_BOUNDS;
        }

        /// <summary>
        /// Optimizes mesh vertex data by converting to half-precision floats where applicable.
        /// - Positions: Float16 only if bounds less than 16m, otherwise Float32
        /// - Normals, Tangents, Colors, UVs: Always Float16
        /// </summary>
        /// <param name="mesh">The mesh to optimize</param>
        public static void ConvertToHalfPrecisionPositions(Mesh mesh)
        {
            if (!IsEligibleForOptimization(mesh))
                return;

            try
            {
                bool useHalfPositions = CanUseHalfPrecisionPositions(mesh);
                ConvertUsingMeshDataApi(mesh, useHalfPositions);
            }
            catch (Exception e)
            {
                Debug.LogWarning($"MeshOptimizer: Failed to optimize mesh '{mesh.name}': {e.Message}\n{e.StackTrace}");
            }
        }

        private static void ConvertUsingMeshDataApi(Mesh mesh, bool useHalfPositions)
        {
            int vertexCount = mesh.vertexCount;

            // Read all current vertex data
            var positions = mesh.vertices;
            var normals = mesh.normals;
            var tangents = mesh.tangents;
            var colors = mesh.colors;
            var colors32 = mesh.colors32;
            var uv = mesh.uv;
            var uv2 = mesh.uv2;
            var uv3 = mesh.uv3;
            var uv4 = mesh.uv4;
            var boneWeights = mesh.boneWeights;
            var bindposes = mesh.bindposes;
            var bounds = mesh.bounds;

            // Store submesh data
            int subMeshCount = mesh.subMeshCount;
            var subMeshIndices = new List<int[]>();
            var subMeshTopologies = new MeshTopology[subMeshCount];
            for (int i = 0; i < subMeshCount; i++)
            {
                subMeshIndices.Add(mesh.GetIndices(i));
                subMeshTopologies[i] = mesh.GetTopology(i);
            }

            // Store blend shapes
            int blendShapeCount = mesh.blendShapeCount;
            var blendShapeData = new List<BlendShapeData>();
            for (int i = 0; i < blendShapeCount; i++)
            {
                string shapeName = mesh.GetBlendShapeName(i);
                int frameCount = mesh.GetBlendShapeFrameCount(i);
                var frames = new List<BlendShapeFrame>();

                for (int j = 0; j < frameCount; j++)
                {
                    float weight = mesh.GetBlendShapeFrameWeight(i, j);
                    var deltaVertices = new Vector3[vertexCount];
                    var deltaNormals = new Vector3[vertexCount];
                    var deltaTangents = new Vector3[vertexCount];
                    mesh.GetBlendShapeFrameVertices(i, j, deltaVertices, deltaNormals, deltaTangents);

                    frames.Add(new BlendShapeFrame
                    {
                        weight = weight,
                        deltaVertices = deltaVertices,
                        deltaNormals = deltaNormals,
                        deltaTangents = deltaTangents
                    });
                }

                blendShapeData.Add(new BlendShapeData { name = shapeName, frames = frames });
            }

            // Build vertex attribute list
            // NOTE: Unity requires vertex attributes to be aligned to 4 bytes
            var vertexAttributes = new List<VertexAttributeDescriptor>();

            bool hasNormals = normals != null && normals.Length == vertexCount;
            bool hasTangents = tangents != null && tangents.Length == vertexCount;
            bool hasColors = colors != null && colors.Length == vertexCount;
            bool hasColors32 = colors32 != null && colors32.Length == vertexCount;
            bool hasUV = uv != null && uv.Length == vertexCount;
            bool hasUV2 = uv2 != null && uv2.Length == vertexCount;
            bool hasUV3 = uv3 != null && uv3.Length == vertexCount;
            bool hasUV4 = uv4 != null && uv4.Length == vertexCount;

            // Position: Float16 x 4 (8 bytes) if small bounds, else Float32 x 3 (12 bytes)
            if (useHalfPositions)
            {
                vertexAttributes.Add(new VertexAttributeDescriptor(
                    VertexAttribute.Position, VertexAttributeFormat.Float16, 4, 0));
            }
            else
            {
                vertexAttributes.Add(new VertexAttributeDescriptor(
                    VertexAttribute.Position, VertexAttributeFormat.Float32, 3, 0));
            }

            // Normal: Always Float16 x 4 (8 bytes) - normals are always [-1,1] range
            if (hasNormals)
                vertexAttributes.Add(new VertexAttributeDescriptor(
                    VertexAttribute.Normal, VertexAttributeFormat.Float16, 4, 0));

            // Tangent: Always Float16 x 4 (8 bytes) - tangents are always [-1,1] range
            if (hasTangents)
                vertexAttributes.Add(new VertexAttributeDescriptor(
                    VertexAttribute.Tangent, VertexAttributeFormat.Float16, 4, 0));

            // Colors: Float16 x 4 (8 bytes) or UNorm8 x 4 (4 bytes)
            if (hasColors)
                vertexAttributes.Add(new VertexAttributeDescriptor(
                    VertexAttribute.Color, VertexAttributeFormat.Float16, 4, 0));
            else if (hasColors32)
                vertexAttributes.Add(new VertexAttributeDescriptor(
                    VertexAttribute.Color, VertexAttributeFormat.UNorm8, 4, 0));

            // UVs: Always Float16 x 2 (4 bytes) - UVs are typically [0,1] range
            if (hasUV)
                vertexAttributes.Add(new VertexAttributeDescriptor(
                    VertexAttribute.TexCoord0, VertexAttributeFormat.Float16, 2, 0));

            if (hasUV2)
                vertexAttributes.Add(new VertexAttributeDescriptor(
                    VertexAttribute.TexCoord1, VertexAttributeFormat.Float16, 2, 0));

            if (hasUV3)
                vertexAttributes.Add(new VertexAttributeDescriptor(
                    VertexAttribute.TexCoord2, VertexAttributeFormat.Float16, 2, 0));

            if (hasUV4)
                vertexAttributes.Add(new VertexAttributeDescriptor(
                    VertexAttribute.TexCoord3, VertexAttributeFormat.Float16, 2, 0));

            // Calculate total indices
            int totalIndices = 0;
            foreach (var idx in subMeshIndices)
                totalIndices += idx.Length;

            // Create writable mesh data
            var meshDataArray = Mesh.AllocateWritableMeshData(1);
            var meshData = meshDataArray[0];

            meshData.SetVertexBufferParams(vertexCount, vertexAttributes.ToArray());
            meshData.SetIndexBufferParams(totalIndices, IndexFormat.UInt32);

            // Get the vertex data as a native array and write to it
            var vertexData = meshData.GetVertexData<byte>(0);

            // Calculate stride (bytes per vertex)
            int stride = useHalfPositions ? 8 : 12; // Position
            if (hasNormals) stride += 8; // Float16 x 4
            if (hasTangents) stride += 8; // Float16 x 4
            if (hasColors) stride += 8; // Float16 x 4
            else if (hasColors32) stride += 4; // UNorm8 x 4
            if (hasUV) stride += 4; // Float16 x 2
            if (hasUV2) stride += 4;
            if (hasUV3) stride += 4;
            if (hasUV4) stride += 4;

            // Write vertex data
            unsafe
            {
                byte* vertexPtr = (byte*)vertexData.GetUnsafePtr();

                for (int i = 0; i < vertexCount; i++)
                {
                    int offset = 0;

                    // Position
                    if (useHalfPositions)
                    {
                        // Float16 x 4 (8 bytes, 4th component is padding)
                        ushort* posPtr = (ushort*)(vertexPtr + i * stride + offset);
                        posPtr[0] = Mathf.FloatToHalf(positions[i].x);
                        posPtr[1] = Mathf.FloatToHalf(positions[i].y);
                        posPtr[2] = Mathf.FloatToHalf(positions[i].z);
                        posPtr[3] = Mathf.FloatToHalf(1.0f); // w = 1 for positions
                        offset += 8;
                    }
                    else
                    {
                        // Float32 x 3 (12 bytes)
                        float* posPtr = (float*)(vertexPtr + i * stride + offset);
                        posPtr[0] = positions[i].x;
                        posPtr[1] = positions[i].y;
                        posPtr[2] = positions[i].z;
                        offset += 12;
                    }

                    // Normal (Float16 x 4 = 8 bytes)
                    if (hasNormals)
                    {
                        ushort* normPtr = (ushort*)(vertexPtr + i * stride + offset);
                        normPtr[0] = Mathf.FloatToHalf(normals[i].x);
                        normPtr[1] = Mathf.FloatToHalf(normals[i].y);
                        normPtr[2] = Mathf.FloatToHalf(normals[i].z);
                        normPtr[3] = Mathf.FloatToHalf(0.0f); // padding
                        offset += 8;
                    }

                    // Tangent (Float16 x 4 = 8 bytes)
                    if (hasTangents)
                    {
                        ushort* tanPtr = (ushort*)(vertexPtr + i * stride + offset);
                        tanPtr[0] = Mathf.FloatToHalf(tangents[i].x);
                        tanPtr[1] = Mathf.FloatToHalf(tangents[i].y);
                        tanPtr[2] = Mathf.FloatToHalf(tangents[i].z);
                        tanPtr[3] = Mathf.FloatToHalf(tangents[i].w);
                        offset += 8;
                    }

                    // Color (Float16 x 4 or UNorm8 x 4)
                    if (hasColors)
                    {
                        ushort* colPtr = (ushort*)(vertexPtr + i * stride + offset);
                        colPtr[0] = Mathf.FloatToHalf(colors[i].r);
                        colPtr[1] = Mathf.FloatToHalf(colors[i].g);
                        colPtr[2] = Mathf.FloatToHalf(colors[i].b);
                        colPtr[3] = Mathf.FloatToHalf(colors[i].a);
                        offset += 8;
                    }
                    else if (hasColors32)
                    {
                        byte* colPtr = vertexPtr + i * stride + offset;
                        colPtr[0] = colors32[i].r;
                        colPtr[1] = colors32[i].g;
                        colPtr[2] = colors32[i].b;
                        colPtr[3] = colors32[i].a;
                        offset += 4;
                    }

                    // UV0 (Float16 x 2 = 4 bytes)
                    if (hasUV)
                    {
                        ushort* uvPtr = (ushort*)(vertexPtr + i * stride + offset);
                        uvPtr[0] = Mathf.FloatToHalf(uv[i].x);
                        uvPtr[1] = Mathf.FloatToHalf(uv[i].y);
                        offset += 4;
                    }

                    // UV1 (Float16 x 2 = 4 bytes)
                    if (hasUV2)
                    {
                        ushort* uvPtr = (ushort*)(vertexPtr + i * stride + offset);
                        uvPtr[0] = Mathf.FloatToHalf(uv2[i].x);
                        uvPtr[1] = Mathf.FloatToHalf(uv2[i].y);
                        offset += 4;
                    }

                    // UV2 (Float16 x 2 = 4 bytes)
                    if (hasUV3)
                    {
                        ushort* uvPtr = (ushort*)(vertexPtr + i * stride + offset);
                        uvPtr[0] = Mathf.FloatToHalf(uv3[i].x);
                        uvPtr[1] = Mathf.FloatToHalf(uv3[i].y);
                        offset += 4;
                    }

                    // UV3 (Float16 x 2 = 4 bytes)
                    if (hasUV4)
                    {
                        ushort* uvPtr = (ushort*)(vertexPtr + i * stride + offset);
                        uvPtr[0] = Mathf.FloatToHalf(uv4[i].x);
                        uvPtr[1] = Mathf.FloatToHalf(uv4[i].y);
                        offset += 4;
                    }
                }
            }

            // Write index data
            var indexData = meshData.GetIndexData<int>();
            int indexOffset = 0;
            for (int i = 0; i < subMeshCount; i++)
            {
                var indices = subMeshIndices[i];
                for (int j = 0; j < indices.Length; j++)
                {
                    indexData[indexOffset + j] = indices[j];
                }
                indexOffset += indices.Length;
            }

            // Set submesh descriptors
            meshData.subMeshCount = subMeshCount;
            indexOffset = 0;
            for (int i = 0; i < subMeshCount; i++)
            {
                var descriptor = new SubMeshDescriptor(indexOffset, subMeshIndices[i].Length, subMeshTopologies[i]);
                meshData.SetSubMesh(i, descriptor, MeshUpdateFlags.DontRecalculateBounds | MeshUpdateFlags.DontValidateIndices);
                indexOffset += subMeshIndices[i].Length;
            }

            // Apply the mesh data
            mesh.Clear();
            Mesh.ApplyAndDisposeWritableMeshData(meshDataArray, mesh,
                MeshUpdateFlags.DontRecalculateBounds | MeshUpdateFlags.DontValidateIndices);

            // Set bounds
            mesh.bounds = bounds;

            // Restore bone weights and bindposes for skinned meshes
            if (boneWeights != null && boneWeights.Length > 0)
                mesh.boneWeights = boneWeights;
            if (bindposes != null && bindposes.Length > 0)
                mesh.bindposes = bindposes;

            // Restore blend shapes
            foreach (var shape in blendShapeData)
            {
                foreach (var frame in shape.frames)
                {
                    mesh.AddBlendShapeFrame(
                        shape.name,
                        frame.weight,
                        frame.deltaVertices,
                        frame.deltaNormals,
                        frame.deltaTangents
                    );
                }
            }

            // Upload to GPU
            mesh.UploadMeshData(false);
        }

        // Helper structs for blend shape data preservation
        private struct BlendShapeFrame
        {
            public float weight;
            public Vector3[] deltaVertices;
            public Vector3[] deltaNormals;
            public Vector3[] deltaTangents;
        }

        private struct BlendShapeData
        {
            public string name;
            public List<BlendShapeFrame> frames;
        }
    }
}
