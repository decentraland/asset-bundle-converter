using UnityEngine;
using System;
using System.Collections.Generic;
using UnityEngine.Rendering;

public class CustomMeshRenderer : MonoBehaviour
{
    [System.Serializable]
    private struct MeshInfo
    {
        public int vertexStart;
        public int vertexCount;
        public int indexStart;
        public int indexCount;
    }
    
    private struct ObjRenderFlags
    {
        public bool isVisible;
        public int nLODLevel;
    }
    
    List<ObjRenderFlags> ObjectRenderFlags = new List<ObjRenderFlags>();
    public Mesh combinedMesh;
    public Mesh[,] m_mesh = new Mesh[2, 5];
    public Material[] m_material = new Material[2];
    private List<MeshInfo> meshInfos;
    public Transform objectTransform;
    
    private GraphicsBuffer[,] meshIndices = new GraphicsBuffer[2, 5];
    private GraphicsBuffer[,] meshPositions = new GraphicsBuffer[2,5];
    private GraphicsBuffer[,] meshNormals = new GraphicsBuffer[2,5];
    private GraphicsBuffer[,] meshTangents = new GraphicsBuffer[2,5];
    private GraphicsBuffer[,] meshTexcoords = new GraphicsBuffer[2,5];

    private CommandBuffer cmd;

    // Knowledge of OctTree and built status
    // Knowledge of Objects and Mesh data (1to1 array)
    // Communication to system to say that a GameObject is no longer considered static
    // Communication to server to inform of GameObject state change
    // Knowledge of streaming system
    // Knowledge of LOD state
    
    void Start()
    {
        cmd = new CommandBuffer();
        cmd.name = "Custom Mesh Renderer";

        // Add this command buffer to the main light's shadow pass
        Light mainLight = RenderSettings.sun;
        if (mainLight != null)
        {
            mainLight.AddCommandBuffer(LightEvent.BeforeScreenspaceMask, cmd);
        }
    }

    void DrawMeshStream(int nOpacity, int nLODLevel, Material _material, int _indexStart, int _indexCount, int _instanceCount)
    {
        MaterialPropertyBlock properties = new MaterialPropertyBlock();
        properties.SetBuffer("_Positions", meshPositions[nOpacity, nLODLevel]);
        properties.SetBuffer("_Normals", meshNormals[nOpacity, nLODLevel]);
        properties.SetBuffer("_Tangents", meshTangents[nOpacity, nLODLevel]);
        properties.SetBuffer("_Texcoords", meshTexcoords[nOpacity, nLODLevel]);
        properties.SetInt("_StartIndex", _indexStart);
        cmd.DrawProcedural(meshIndices[nOpacity, nLODLevel], objectTransform.localToWorldMatrix, _material, shaderPass:0, MeshTopology.Triangles, _indexCount, _instanceCount, properties);
    }
    
    void Update()
    {
        cmd.Clear();
        
        int nVertexStart = Int32.MaxValue;
        int nIndexStart = Int32.MaxValue;
        int nVertexCount = 0;
        int nIndexCount = 0;
        int nMaxLODLevel = 5;
        for (int nOpacity = 0; nOpacity < 2; ++nOpacity)
        {
            for (int nLODLevel = 0; nLODLevel < nMaxLODLevel; ++nLODLevel)
            {
                for (int i = 0; i < ObjectRenderFlags.Count; ++i)
                {
                    if (ObjectRenderFlags[i].isVisible == true)
                    {
                        if (ObjectRenderFlags[i].nLODLevel == nLODLevel)
                        {
                            if (nVertexStart == Int32.MaxValue)
                            {
                                nVertexStart = meshInfos[i].vertexStart;
                                nIndexStart = meshInfos[i].indexStart;
                            }

                            nVertexCount += meshInfos[i].vertexCount;
                            nIndexCount += meshInfos[i].indexCount;

                            continue;
                        }
                    }
                    
                    if (nVertexCount > 0 && nIndexCount > 0) // Draw all previously collated meshes
                    {
                        DrawMeshStream(nOpacity, nLODLevel, m_material[nOpacity], nIndexStart, nIndexCount, 0);
                        nVertexStart = Int32.MaxValue;
                        nIndexStart = Int32.MaxValue;
                        nVertexCount = 0;
                        nIndexCount = 0;
                    }
                }
                DrawMeshStream(nOpacity, nLODLevel, m_material[nOpacity], nIndexStart, nIndexCount, 0);
            }
        }
    }

    void OnDestroy()
    {
        Light mainLight = RenderSettings.sun;
        if (mainLight != null)
        {
            mainLight.RemoveCommandBuffer(LightEvent.BeforeScreenspaceMask, cmd);
        }
        cmd.Release();
    }
}