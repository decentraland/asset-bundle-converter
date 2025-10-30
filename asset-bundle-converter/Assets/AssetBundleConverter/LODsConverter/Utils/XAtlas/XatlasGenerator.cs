using System;
using UnityEngine;
using UnityEditor;
using XAtlasWrapper;
using System.Collections.Generic;
using System.Runtime.InteropServices;

public class XAtlasGenerator
{
    // Cached atlas for two-step workflow
    private IntPtr cachedAtlasPtr = IntPtr.Zero;
    private List<GCHandle> cachedPinnedHandles = new List<GCHandle>();
    private GCHandle cachedProgressCallbackHandle;

    // Progress callback
    public Action<string, float> OnProgress;

    public bool IsChartsGenerated { get; private set; }
    public uint CachedChartCount { get; private set; }

    public void Cleanup()
    {
        foreach (var handle in cachedPinnedHandles)
        {
            if (handle.IsAllocated)
                handle.Free();
        }
        cachedPinnedHandles.Clear();

        if (cachedProgressCallbackHandle.IsAllocated)
            cachedProgressCallbackHandle.Free();

        if (cachedAtlasPtr != IntPtr.Zero)
        {
            XAtlasNative.xatlasDestroy(cachedAtlasPtr);
            cachedAtlasPtr = IntPtr.Zero;
        }

        IsChartsGenerated = false;
        CachedChartCount = 0;
    }

    public Atlas GenerateAtlasOneStep(List<GameObject> sourceMeshes, ChartOptions chartOptions, PackOptions packOptions)
    {
        IntPtr atlasPtr = IntPtr.Zero;
        GCHandle progressCallbackHandle = default;
        List<GCHandle> pinnedHandles = new List<GCHandle>();

        try
        {
            atlasPtr = XAtlasNative.xatlasCreate();
            if (atlasPtr == IntPtr.Zero)
            {
                throw new System.Exception("Failed to create XAtlas instance");
            }

            ProgressFunc progressCallback = CreateProgressCallback();
            progressCallbackHandle = GCHandle.Alloc(progressCallback);
            XAtlasNative.xatlasSetProgressCallback(atlasPtr, progressCallback, IntPtr.Zero);

            AddMeshesToAtlas(atlasPtr, sourceMeshes, pinnedHandles);

            XAtlasNative.xatlasGenerate(atlasPtr, ref chartOptions, ref packOptions);

            Atlas result = Marshal.PtrToStructure<Atlas>(atlasPtr);
            LogResults(result);

            return result;
        }
        finally
        {
            foreach (var handle in pinnedHandles)
            {
                if (handle.IsAllocated)
                    handle.Free();
            }

            if (progressCallbackHandle.IsAllocated)
                progressCallbackHandle.Free();

            if (atlasPtr != IntPtr.Zero)
                XAtlasNative.xatlasDestroy(atlasPtr);
        }
    }

    public void GenerateChartsOnly(List<GameObject> sourceMeshes, ChartOptions chartOptions)
    {
        Cleanup();

        cachedAtlasPtr = XAtlasNative.xatlasCreate();
        if (cachedAtlasPtr == IntPtr.Zero)
        {
            throw new System.Exception("Failed to create XAtlas instance");
        }

        // DON'T set progress callback for testing
        // ProgressFunc progressCallback = CreateProgressCallback();
        // cachedProgressCallbackHandle = GCHandle.Alloc(progressCallback);
        // XAtlasNative.xatlasSetProgressCallback(cachedAtlasPtr, progressCallback, IntPtr.Zero);

        Debug.Log("About to add meshes...");
        AddMeshesToAtlas(cachedAtlasPtr, sourceMeshes, cachedPinnedHandles);

        Debug.Log("About to call xatlasAddMeshJoin - this might take a while...");
        // This is where it hangs

        Debug.Log("Calling xatlasComputeCharts...");
        XAtlasNative.xatlasComputeCharts(cachedAtlasPtr, ref chartOptions);

        Atlas partialResult = Marshal.PtrToStructure<Atlas>(cachedAtlasPtr);
        CachedChartCount = partialResult.chartCount;
        IsChartsGenerated = true;

        Debug.Log($"Generated {CachedChartCount} charts");
    }

    public Atlas PackChartsOnly(PackOptions packOptions)
    {
        if (cachedAtlasPtr == IntPtr.Zero || !IsChartsGenerated)
        {
            throw new System.Exception("No charts available to pack. Generate charts first.");
        }

        XAtlasNative.xatlasPackCharts(cachedAtlasPtr, ref packOptions);

        Atlas result = Marshal.PtrToStructure<Atlas>(cachedAtlasPtr);
        LogResults(result);

        Cleanup();

        return result;
    }

    private ProgressFunc CreateProgressCallback()
    {
        return (category, progress, userData) =>
        {
            IntPtr categoryStrPtr = XAtlasNative.xatlasProgressCategoryString(category);
            string operation = Marshal.PtrToStringAnsi(categoryStrPtr);
            OnProgress?.Invoke(operation, progress);
            return true;
        };
    }

    private void AddMeshesToAtlas(IntPtr atlasPtr, List<GameObject> sourceMeshes, List<GCHandle> pinnedHandles)
    {
        OnProgress?.Invoke("Adding meshes...", 0);

        foreach (GameObject obj in sourceMeshes)
        {
            MeshFilter meshFilter = obj.GetComponent<MeshFilter>();
            if (meshFilter == null || meshFilter.sharedMesh == null)
                continue;

            UnityEngine.Mesh mesh = meshFilter.sharedMesh;
            AddMeshError error = AddUnityMeshToAtlas(atlasPtr, mesh, pinnedHandles);

            if (error != AddMeshError.Success)
            {
                Debug.LogError($"Failed to add mesh {obj.name}: {GetErrorString(error)}");
            }
        }

        XAtlasNative.xatlasAddMeshJoin(atlasPtr);
    }

    private AddMeshError AddUnityMeshToAtlas(IntPtr atlasPtr, UnityEngine.Mesh mesh, List<GCHandle> pinnedHandles)
    {
        Vector3[] vertices = mesh.vertices;
        Vector3[] normals = mesh.normals;
        Vector2[] uv = mesh.uv;
        int[] triangles = mesh.triangles;

        GCHandle verticesHandle = GCHandle.Alloc(vertices, GCHandleType.Pinned);
        GCHandle trianglesHandle = GCHandle.Alloc(triangles, GCHandleType.Pinned);
        pinnedHandles.Add(verticesHandle);
        pinnedHandles.Add(trianglesHandle);

        XAtlasNative.xatlasMeshDeclInit(out MeshDecl decl);

        decl.vertexCount = (uint)vertices.Length;
        decl.vertexPositionData = verticesHandle.AddrOfPinnedObject();
        decl.vertexPositionStride = (uint)Marshal.SizeOf<Vector3>();

        if (normals != null && normals.Length > 0)
        {
            GCHandle normalsHandle = GCHandle.Alloc(normals, GCHandleType.Pinned);
            pinnedHandles.Add(normalsHandle);
            decl.vertexNormalData = normalsHandle.AddrOfPinnedObject();
            decl.vertexNormalStride = (uint)Marshal.SizeOf<Vector3>();
        }

        if (uv != null && uv.Length > 0)
        {
            GCHandle uvHandle = GCHandle.Alloc(uv, GCHandleType.Pinned);
            pinnedHandles.Add(uvHandle);
            decl.vertexUvData = uvHandle.AddrOfPinnedObject();
            decl.vertexUvStride = (uint)Marshal.SizeOf<Vector2>();
        }

        decl.indexCount = (uint)triangles.Length;
        decl.indexData = trianglesHandle.AddrOfPinnedObject();
        decl.indexFormat = IndexFormat.UInt32;

        return XAtlasNative.xatlasAddMesh(atlasPtr, ref decl, 0);
    }

    private void LogResults(Atlas result)
    {
        Debug.Log($"Generated {result.atlasCount} atlases at {result.width}x{result.height}");
        Debug.Log($"Texels per unit: {result.texelsPerUnit}");
        Debug.Log($"Total charts: {result.chartCount}");

        if (result.utilization != IntPtr.Zero)
        {
            float[] utilization = new float[result.atlasCount];
            Marshal.Copy(result.utilization, utilization, 0, (int)result.atlasCount);
            for (int i = 0; i < utilization.Length; i++)
            {
                Debug.Log($"Atlas {i} utilization: {utilization[i] * 100:F1}%");
            }
        }
    }

    private string GetErrorString(AddMeshError error)
    {
        IntPtr ptr = XAtlasNative.xatlasAddMeshErrorString(error);
        return Marshal.PtrToStringAnsi(ptr);
    }

    public static string GetUtilizationString(Atlas result)
    {
        if (result.utilization == IntPtr.Zero)
            return "";

        string utilizationInfo = "";
        float[] utilization = new float[result.atlasCount];
        Marshal.Copy(result.utilization, utilization, 0, (int)result.atlasCount);

        for (int i = 0; i < utilization.Length; i++)
        {
            utilizationInfo += $"Atlas {i}: {utilization[i] * 100:F1}%\n";
        }

        return utilizationInfo;
    }
}
