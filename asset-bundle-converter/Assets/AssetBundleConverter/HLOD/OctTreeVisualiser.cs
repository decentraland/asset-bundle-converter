// using UnityEngine;
// using System.Collections.Generic;
// using System.Linq;
//
// public class TreeStatistics
// {
//     public int TotalNodes { get; set; }
//     public int LeafNodes { get; set; }
//     public int MaxDepth { get; set; }
//     public int TotalObjects { get; set; }
//     public Dictionary<int, int> ObjectsPerLevel { get; set; } = new Dictionary<int, int>();
// }
//
// public class OctTreeVisualizer : MonoBehaviour
// {
//     public OctTreeManager octTreeManager;
//     public bool showObjectCount = true;
//     public bool showLODLevels = true;
//     public bool showDetailedStats = true;
//
//     private TreeStatistics currentStats;
//     private float updateInterval = 1f;
//     private float lastUpdateTime;
//
//     private void Update()
//     {
//         if (Time.time - lastUpdateTime > updateInterval)
//         {
//             currentStats = octTreeManager.GetTreeStatistics();
//             lastUpdateTime = Time.time;
//         }
//     }
//
//     private void OnGUI()
//     {
//         if (octTreeManager == null || octTreeManager.octTree == null)
//             return;
//
//         GUILayout.BeginArea(new Rect(10, 10, 300, 400));
//         
//         if (showObjectCount)
//         {
//             GUILayout.Label($"Total Objects: {currentStats.TotalObjects}");
//         }
//
//         if (showLODLevels)
//         {
//             GUILayout.Label($"LOD Levels: {octTreeManager.lodDistances.Length}");
//         }
//
//         if (showDetailedStats)
//         {
//             GUILayout.Label("Detailed Statistics:");
//             GUILayout.Label($"Total Nodes: {currentStats.TotalNodes}");
//             GUILayout.Label($"Leaf Nodes: {currentStats.LeafNodes}");
//             GUILayout.Label($"Max Depth: {currentStats.MaxDepth}");
//             
//             GUILayout.Label("Objects per Level:");
//             foreach (var kvp in currentStats.ObjectsPerLevel.OrderBy(k => k.Key))
//             {
//                 GUILayout.Label($"  Level {kvp.Key}: {kvp.Value} objects");
//             }
//         }
//
//         GUILayout.EndArea();
//     }
// }