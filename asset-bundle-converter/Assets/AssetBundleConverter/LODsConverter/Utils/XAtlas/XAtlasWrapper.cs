using System;
using System.Runtime.InteropServices;
using UnityEngine;

namespace XAtlasWrapper
{
    public enum ChartType
    {
        Planar,
        Ortho,
        LSCM,
        Piecewise,
        Invalid
    }

    public enum IndexFormat
    {
        UInt16,
        UInt32
    }

    public enum AddMeshError
    {
        Success,
        Error,
        IndexOutOfRange,
        InvalidFaceVertexCount,
        InvalidIndexCount
    }

    public enum ProgressCategory
    {
        AddMesh,
        ComputeCharts,
        PackCharts,
        BuildOutputMeshes
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct Chart
    {
        public IntPtr faceArray;
        public uint atlasIndex;
        public uint faceCount;
        public ChartType type;
        public uint material;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct Vertex
    {
        public int atlasIndex;
        public int chartIndex;
        [MarshalAs(UnmanagedType.ByValArray, SizeConst = 2)]
        public float[] uv;
        public uint xref;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct Mesh
    {
        public IntPtr chartArray;
        public IntPtr indexArray;
        public IntPtr vertexArray;
        public uint chartCount;
        public uint indexCount;
        public uint vertexCount;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct Atlas
    {
        public IntPtr image;
        public IntPtr meshes;
        public IntPtr utilization;
        public uint width;
        public uint height;
        public uint atlasCount;
        public uint chartCount;
        public uint meshCount;
        public float texelsPerUnit;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct MeshDecl
    {
        public IntPtr vertexPositionData;
        public IntPtr vertexNormalData;
        public IntPtr vertexUvData;
        public IntPtr indexData;
        public IntPtr faceIgnoreData;
        public IntPtr faceMaterialData;
        public IntPtr faceVertexCount;
        public uint vertexCount;
        public uint vertexPositionStride;
        public uint vertexNormalStride;
        public uint vertexUvStride;
        public uint indexCount;
        public int indexOffset;
        public uint faceCount;
        public IndexFormat indexFormat;
        public float epsilon;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct ChartOptions
    {
        public IntPtr paramFunc;
        public float maxChartArea;
        public float maxBoundaryLength;
        public float normalDeviationWeight;
        public float roundnessWeight;
        public float straightnessWeight;
        public float normalSeamWeight;
        public float textureSeamWeight;
        public float maxCost;
        public uint maxIterations;
        [MarshalAs(UnmanagedType.I1)]
        public bool useInputMeshUvs;
        [MarshalAs(UnmanagedType.I1)]
        public bool fixWinding;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct PackOptions
    {
        public uint maxChartSize;
        public uint padding;
        public float texelsPerUnit;
        public uint resolution;
        [MarshalAs(UnmanagedType.I1)]
        public bool bilinear;
        [MarshalAs(UnmanagedType.I1)]
        public bool blockAlign;
        [MarshalAs(UnmanagedType.I1)]
        public bool bruteForce;
        [MarshalAs(UnmanagedType.I1)]
        public bool createImage;
        [MarshalAs(UnmanagedType.I1)]
        public bool rotateChartsToAxis;
        [MarshalAs(UnmanagedType.I1)]
        public bool rotateCharts;
    }

    [UnmanagedFunctionPointer(CallingConvention.Cdecl)]
    public delegate bool ProgressFunc(ProgressCategory category, int progress, IntPtr userData);

    public static class XAtlasNative
    {
        // Try different DLL names based on platform
#if UNITY_EDITOR_WIN || UNITY_STANDALONE_WIN
        private const string DllName = "xatlas";
#elif UNITY_EDITOR_OSX || UNITY_STANDALONE_OSX
        private const string DllName = "libxatlas";
#else
        private const string DllName = "xatlas";
#endif

        [DllImport(DllName, CallingConvention = CallingConvention.Cdecl, EntryPoint = "xatlasCreate")]
        public static extern IntPtr xatlasCreate();

        [DllImport(DllName, CallingConvention = CallingConvention.Cdecl, EntryPoint = "xatlasDestroy")]
        public static extern void xatlasDestroy(IntPtr atlas);

        [DllImport(DllName, CallingConvention = CallingConvention.Cdecl, EntryPoint = "xatlasAddMesh")]
        public static extern AddMeshError xatlasAddMesh(IntPtr atlas, ref MeshDecl meshDecl, uint meshCountHint);

        [DllImport(DllName, CallingConvention = CallingConvention.Cdecl, EntryPoint = "xatlasAddMeshJoin")]
        public static extern void xatlasAddMeshJoin(IntPtr atlas);

        [DllImport(DllName, CallingConvention = CallingConvention.Cdecl, EntryPoint = "xatlasComputeCharts")]
        public static extern void xatlasComputeCharts(IntPtr atlas, ref ChartOptions options);

        [DllImport(DllName, CallingConvention = CallingConvention.Cdecl, EntryPoint = "xatlasPackCharts")]
        public static extern void xatlasPackCharts(IntPtr atlas, ref PackOptions options);

        [DllImport(DllName, CallingConvention = CallingConvention.Cdecl, EntryPoint = "xatlasGenerate")]
        public static extern void xatlasGenerate(IntPtr atlas, ref ChartOptions chartOptions, ref PackOptions packOptions);

        [DllImport(DllName, CallingConvention = CallingConvention.Cdecl, EntryPoint = "xatlasSetProgressCallback")]
        public static extern void xatlasSetProgressCallback(IntPtr atlas, ProgressFunc progressFunc, IntPtr userData);

        [DllImport(DllName, CallingConvention = CallingConvention.Cdecl, EntryPoint = "xatlasMeshDeclInit")]
        public static extern void xatlasMeshDeclInit(out MeshDecl meshDecl);

        [DllImport(DllName, CallingConvention = CallingConvention.Cdecl, EntryPoint = "xatlasChartOptionsInit")]
        public static extern void xatlasChartOptionsInit(out ChartOptions chartOptions);

        [DllImport(DllName, CallingConvention = CallingConvention.Cdecl, EntryPoint = "xatlasPackOptionsInit")]
        public static extern void xatlasPackOptionsInit(out PackOptions packOptions);

        [DllImport(DllName, CallingConvention = CallingConvention.Cdecl, EntryPoint = "xatlasAddMeshErrorString")]
        public static extern IntPtr xatlasAddMeshErrorString(AddMeshError error);

        [DllImport(DllName, CallingConvention = CallingConvention.Cdecl, EntryPoint = "xatlasProgressCategoryString")]
        public static extern IntPtr xatlasProgressCategoryString(ProgressCategory category);
    }
}
