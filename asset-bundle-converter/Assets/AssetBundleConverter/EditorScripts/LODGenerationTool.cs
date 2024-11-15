using UnityEngine;
using UnityEditor;
using System.Collections.Generic;
using Unity.VisualScripting;
using UnityMeshSimplifier;

public class LODGenerationTool : EditorWindow
{
    private float[] lodLevels = new float[] { 0.8f, 0.6f, 0.4f, 0.2f, 0.1f, 0.05f };
    private int minTriangleCount = 512;

    [MenuItem("Tools/Generate LODs")]
    public static void ShowWindow()
    {
        GetWindow<LODGenerationTool>("LOD Generation");
    }

    void OnGUI()
    {
        GUILayout.Label("LOD Generation Settings", EditorStyles.boldLabel);

        EditorGUILayout.BeginVertical();
        for (int i = 0; i < lodLevels.Length; i++)
        {
            lodLevels[i] = EditorGUILayout.Slider($"LOD {i + 1} Quality", lodLevels[i], 0.01f, 1f);
        }
        EditorGUILayout.EndVertical();

        minTriangleCount = EditorGUILayout.IntField("Minimum Triangle Count", minTriangleCount);

        if (GUILayout.Button("Generate LODs"))
        {
            GenerateLODs();
        }
    }

    void GenerateLODs()
    {
        GameObject[] selectedObjects = Selection.gameObjects;

        foreach (GameObject obj in selectedObjects)
        {
            MeshFilter meshFilter = obj.GetComponent<MeshFilter>();
            MeshRenderer meshRenderer = obj.GetComponent<MeshRenderer>();

            if (meshFilter != null && meshRenderer != null)
            {
                Mesh originalMesh = meshFilter.sharedMesh;
                Material[] materials = meshRenderer.sharedMaterials;

                LODGroup lodGroup = obj.GetComponent<LODGroup>();
                if (lodGroup == null)
                {
                    lodGroup = obj.AddComponent<LODGroup>();
                }

                List<LOD> lods = new List<LOD>();

                // Original mesh as LOD0
                LOD originalLOD = new LOD(1f, new Renderer[] { meshRenderer });
                lods.Add(originalLOD);

                for (int i = 0; i < lodLevels.Length; i++)
                {
                    float quality = lodLevels[i];
                    Mesh simplifiedMesh = SimplifyMesh(originalMesh, quality);

                    if (simplifiedMesh.triangles.Length / 3 <= minTriangleCount)
                    {
                        Debug.Log($"Stopped LOD generation for {obj.name} at LOD {i + 1} due to minimum triangle count.");
                        break;
                    }

                    GameObject lodObject = new GameObject($"LOD_{i + 1}");
                    lodObject.transform.SetParent(obj.transform);
                    lodObject.transform.localPosition = Vector3.zero;
                    lodObject.transform.localRotation = Quaternion.identity;
                    lodObject.transform.localScale = Vector3.one;

                    MeshFilter lodMeshFilter = lodObject.AddComponent<MeshFilter>();
                    lodMeshFilter.sharedMesh = simplifiedMesh;

                    MeshRenderer lodMeshRenderer = lodObject.AddComponent<MeshRenderer>();
                    lodMeshRenderer.sharedMaterials = materials;

                    float lodThreshold = i < lodLevels.Length - 1 ? (lodLevels[i] + lodLevels[i + 1]) / 2 : 0.01f;
                    LOD lod = new LOD(lodThreshold, new Renderer[] { lodMeshRenderer });
                    lods.Add(lod);
                }

                lodGroup.SetLODs(lods.ToArray());
                lodGroup.RecalculateBounds();

                EditorUtility.SetDirty(obj);
            }
        }

        AssetDatabase.SaveAssets();
        AssetDatabase.Refresh();
    }

    Mesh SimplifyMesh(Mesh originalMesh, float quality)
    {
        MeshSimplifier meshSimplifier = new MeshSimplifier();
        meshSimplifier.Initialize(originalMesh);
        meshSimplifier.SimplifyMesh(quality);

        Mesh simplifiedMesh = meshSimplifier.ToMesh();
        LODGeneratorHelper LGH = new LODGeneratorHelper();
        SimplificationOptions SO = new SimplificationOptions();
        SO.PreserveBorderEdges = false;
        SO.PreserveUVSeamEdges = false;
        SO.PreserveUVFoldoverEdges = false;
        SO.PreserveSurfaceCurvature = false;
        SO.EnableSmartLink = true;
        SO.VertexLinkDistance = double.Epsilon;
        SO.MaxIterationCount = 100;
        SO.Agressiveness = 7.0;
        SO.ManualUVComponentCount = false;
        SO.UVComponentCount = 2;
        LGH.SimplificationOptions = SO;
        float screenRelativeTransitionHeight = 1.0f;
        float fadeTransitionWidth = 2.0f;
        float fQuality = 1.0f;
        bool combineMeshes = true;
        bool combineSubMeshes = true;
        Renderer[] renderers = new Renderer[1];
        LGH.Levels[0] = new LODLevel(screenRelativeTransitionHeight, fadeTransitionWidth, fQuality, combineMeshes, combineSubMeshes, renderers);
        
        // LODGroup lodGroup = simplifiedMesh.GetComponent<LODGroup>();
        // LOD[] lods = lodGroup.GetLODs();
        // for (int i = 0; i < lodGroup.lodCount; ++i)
        // {
        //     lods[0].screenRelativeTransitionHeight;
        // }

        return simplifiedMesh;
    }
}