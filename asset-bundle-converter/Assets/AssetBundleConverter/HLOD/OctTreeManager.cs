// using UnityEngine;
// using Unity.Jobs;
// using Unity.Collections;
// using System;
// using System.Collections;
// using System.Collections.Generic;
// using System.IO;
// using Unity.Mathematics;
// using System.Security.Cryptography;
// using System.Text;
// using System.Linq;
// using System.Diagnostics;
//
// public class OctTreeManager : MonoBehaviour
// {
//     public OctTree octTree;
//     public Bounds worldBounds;
//     public float[] lodDistances = { 10f, 50f, 100f, 200f }; // Example distances
//     public Camera mainCamera;
//
//     // [SerializeField]
//     // private string staticObjectTag = "StaticLODObject";
//     
//     [SerializeField] private string staticObjectTag = "StaticLODObject";
//     [SerializeField] private int maxJobBatchSize = 1024;
//     [SerializeField] private int objectsPerFrame = 1000;
//     [SerializeField] private string serializationPath = "OctreeData.bin";
//     [SerializeField] private bool debugMode = false;
//     
//     private List<GameObject> staticObjects;
//     private Coroutine buildTreeCoroutine;
//     private bool isBuilding = false;
//     
//     private const string CODE_VERSION = "1.0.0";
//     
//     // Performance metrics
//     private Stopwatch stopwatch = new Stopwatch();
//     private long lastFullRebuildTime;
//     private long lastGranularUpdateTime;
//     private int lastGranularUpdateNodeCount;
//     private int totalFullRebuilds;
//     private int totalGranularUpdates;
//     private long totalFullRebuildTime;
//     private long totalGranularUpdateTime;
//     
//     [SerializeField] private bool drawDebugGizmos = true;
//     [SerializeField] private bool drawBounds = true;
//     [SerializeField] private bool drawObjects = true;
//     [SerializeField] private bool drawLODLevels = true;
//     [SerializeField] private LayerMask visualizationLayerMask = -1; // All layers by default
//
//     void OnDrawGizmos()
//     {
//         if (octTree == null || !drawDebugGizmos)
//             return;
//
//         if (drawBounds || drawObjects)
//         {
//             octTree.DrawDebugGizmos(drawBounds, drawObjects, visualizationLayerMask);
//         }
//
//         if (drawLODLevels && mainCamera != null)
//         {
//             octTree.DrawLODLevels(mainCamera, mainCamera.transform.position);
//         }
//     }
//
//     public TreeStatistics GetTreeStatistics()
//     {
//         return octTree.GetTreeStatistics();
//     }
//
//     void Awake()
//     {
//         mainCamera = Camera.main;
//         staticObjects = new List<GameObject>(GameObject.FindGameObjectsWithTag(staticObjectTag));
//         
//         Dictionary<string, string> currentHashes = CalculateComponentHashes();
//         
//         if (TryLoadSerializedTree(currentHashes))
//         {
//             UnityEngine.Debug.Log("Loaded serialized Octree.");
//         }
//         else
//         {
//             UnityEngine.Debug.Log("Building new Octree due to changes or missing data.");
//             StartBuildingTree(currentHashes);
//         }
//     }
//     
//     private Dictionary<string, string> CalculateComponentHashes()
//     {
//         Dictionary<string, string> hashes = new Dictionary<string, string>
//         {
//             {"CodeVersion", CODE_VERSION},
//             {"WorldBounds", HashString(worldBounds.ToString())},
//             {"LODDistances", HashString(string.Join(",", lodDistances))},
//             {"ObjectsHash", CalculateObjectsHash()}
//         };
//         return hashes;
//     }
//     
//     private string CalculateObjectsHash()
//     {
//         StringBuilder sb = new StringBuilder();
//         foreach (var obj in staticObjects)
//         {
//             if (obj != null)
//             {
//                 sb.Append(obj.name);
//                 sb.Append(obj.transform.position.ToString());
//                 Renderer renderer = obj.GetComponent<Renderer>();
//                 if (renderer != null)
//                 {
//                     sb.Append(renderer.bounds.size.ToString());
//                 }
//             }
//         }
//         return HashString(sb.ToString());
//     }
//
//     private string HashString(string input)
//     {
//         using (SHA256 sha256 = SHA256.Create())
//         {
//             byte[] hashBytes = sha256.ComputeHash(Encoding.UTF8.GetBytes(input));
//             return BitConverter.ToString(hashBytes).Replace("-", "").Substring(0, 16);
//         }
//     }
//     
//     private string CalculateVersionHash()
//     {
//         StringBuilder sb = new StringBuilder();
//         sb.Append(CODE_VERSION);
//         sb.Append(worldBounds.ToString());
//         sb.Append(string.Join(",", lodDistances));
//         
//         foreach (var obj in staticObjects)
//         {
//             if (obj != null)
//             {
//                 sb.Append(obj.name);
//                 sb.Append(obj.transform.position.ToString());
//                 Renderer renderer = obj.GetComponent<Renderer>();
//                 if (renderer != null)
//                 {
//                     sb.Append(renderer.bounds.size.ToString());
//                 }
//             }
//         }
//
//         using (SHA256 sha256 = SHA256.Create())
//         {
//             byte[] hashBytes = sha256.ComputeHash(Encoding.UTF8.GetBytes(sb.ToString()));
//             return BitConverter.ToString(hashBytes).Replace("-", "").Substring(0, 16);
//         }
//     }
//     
//     private bool TryLoadSerializedTree(Dictionary<string, string> currentHashes)
//     {
//         string fullPath = Path.Combine(Application.persistentDataPath, serializationPath);
//         if (File.Exists(fullPath))
//         {
//             try
//             {
//                 byte[] data = File.ReadAllBytes(fullPath);
//                 OctTree loadedTree = OctTree.Deserialize(data);
//                 
//                 List<string> changedComponents = CompareHashes(loadedTree.componentHashes, currentHashes);
//                 
//                 if (changedComponents.Count == 0)
//                 {
//                     octTree = loadedTree;
//                     octTree.SetObjects(staticObjects);
//                     return true;
//                 }
//                 else
//                 {
//                     if (debugMode)
//                     {
//                         UnityEngine.Debug.Log($"Rebuild triggered due to changes in: {string.Join(", ", changedComponents)}");
//                     }
//                     
//                     if (changedComponents.Count == 1 && changedComponents[0] == "ObjectsHash")
//                     {
//                         PerformGranularRebuild(loadedTree, currentHashes);
//                         return true;
//                     }
//                 }
//             }
//             catch (Exception e)
//             {
//                 UnityEngine.Debug.LogError($"Failed to load serialized Octree: {e.Message}");
//             }
//         }
//         return false;
//     }
//     
//     private List<string> CompareHashes(Dictionary<string, string> oldHashes, Dictionary<string, string> newHashes)
//     {
//         return oldHashes.Where(kvp => !newHashes.ContainsKey(kvp.Key) || newHashes[kvp.Key] != kvp.Value)
//             .Select(kvp => kvp.Key)
//             .ToList();
//     }
//
//     private void PerformGranularRebuild(OctTree oldTree, Dictionary<string, string> newHashes)
//     {
//         stopwatch.Restart();
//
//         OctTree newTree = BuildNewTree(newHashes);
//         List<string> changedNodes = oldTree.GetChangedNodes(newTree);
//
//         if (debugMode)
//         {
//             UnityEngine.Debug.Log($"Performing granular rebuild. Changed nodes: {changedNodes.Count}");
//         }
//
//         oldTree.UpdateNodes(changedNodes);
//         octTree = oldTree; // Use the updated old tree
//         SaveSerializedTree();
//
//         stopwatch.Stop();
//         lastGranularUpdateTime = stopwatch.ElapsedMilliseconds;
//         lastGranularUpdateNodeCount = changedNodes.Count;
//         totalGranularUpdates++;
//         totalGranularUpdateTime += lastGranularUpdateTime;
//
//         if (debugMode)
//         {
//             UnityEngine.Debug.Log($"Granular update completed in {lastGranularUpdateTime}ms. Updated {lastGranularUpdateNodeCount} nodes.");
//         }
//         
//         OnTreeUpdated(false);
//     }
//     
//     private OctTree BuildNewTree(Dictionary<string, string> hashes)
//     {
//         // ... [Implement the tree building logic here, similar to BuildTreeOverTime but without coroutine] ...
//         // This is a placeholder implementation
//         return new OctTree(worldBounds, lodDistances, HashString(string.Join(",", hashes.Values)));
//     }
//     
//     private void StartBuildingTree(Dictionary<string, string> hashes)
//     {
//         if (isBuilding)
//         {
//             UnityEngine.Debug.LogWarning("Tree building is already in progress.");
//             return;
//         }
//
//         if (buildTreeCoroutine != null)
//         {
//             StopCoroutine(buildTreeCoroutine);
//         }
//         buildTreeCoroutine = StartCoroutine(BuildTreeOverTime(hashes));
//     }
//
//     private IEnumerator BuildTreeOverTime(Dictionary<string, string> hashes)
//     {
//         stopwatch.Restart();
//
//         isBuilding = true;
//         int totalObjects = staticObjects.Count;
//         int processedObjects = 0;
//
//         NativeArray<float3> positions = new NativeArray<float3>(totalObjects, Allocator.TempJob);
//         NativeArray<float3> sizes = new NativeArray<float3>(totalObjects, Allocator.TempJob);
//         NativeArray<int> nodeIndices = new NativeArray<int>(totalObjects, Allocator.TempJob);
//
//         try
//         {
//             while (processedObjects < totalObjects)
//             {
//                 int objectsThisFrame = Mathf.Min(objectsPerFrame, totalObjects - processedObjects);
//
//                 for (int i = 0; i < objectsThisFrame; i++)
//                 {
//                     GameObject obj = staticObjects[processedObjects + i];
//                     if (obj != null)
//                     {
//                         positions[processedObjects + i] = obj.transform.position;
//                         sizes[processedObjects + i] = obj.GetComponent<Renderer>().bounds.size;
//                     }
//                     else
//                     {
//                         UnityEngine.Debug.LogWarning($"Null object found at index {processedObjects + i}");
//                         positions[processedObjects + i] = float3.zero;
//                         sizes[processedObjects + i] = float3.zero;
//                     }
//                 }
//
//                 processedObjects += objectsThisFrame;
//                 yield return null;
//             }
//
//             OctreeBuilderJob job = new OctreeBuilderJob
//             {
//                 Positions = positions,
//                 Sizes = sizes,
//                 NodeIndices = nodeIndices,
//                 TreeCenter = worldBounds.center,
//                 TreeSize = worldBounds.size,
//                 MaxDepth = 8 // You can adjust this based on your needs
//             };
//
//             JobHandle jobHandle = job.Schedule(totalObjects, maxJobBatchSize);
//             jobHandle.Complete();
//
//             octTree = new OctTree(worldBounds, lodDistances, string.Join(",", hashes.Values));
//             octTree.InitializeTree(positions, sizes, nodeIndices);
//             octTree.SetObjects(staticObjects);
//             octTree.componentHashes = hashes;
//
//             SaveSerializedTree();
//
//             stopwatch.Stop();
//             lastFullRebuildTime = stopwatch.ElapsedMilliseconds;
//             totalFullRebuilds++;
//             totalFullRebuildTime += lastFullRebuildTime;
//             
//             OnTreeUpdated(true);
//
//             if (debugMode)
//             {
//                 UnityEngine.Debug.Log($"Full Octree rebuild completed in {lastFullRebuildTime}ms.");
//             }
//         }
//         catch (Exception e)
//         {
//             UnityEngine.Debug.LogError($"Error during Octree building: {e.Message}");
//         }
//         finally
//         {
//             positions.Dispose();
//             sizes.Dispose();
//             nodeIndices.Dispose();
//             isBuilding = false;
//         }
//     }
//     
//     private void SaveSerializedTree()
//     {
//         string fullPath = Path.Combine(Application.persistentDataPath, serializationPath);
//         try
//         {
//             byte[] data = octTree.Serialize();
//             File.WriteAllBytes(fullPath, data);
//             UnityEngine.Debug.Log("Octree serialized and saved successfully.");
//         }
//         catch (Exception e)
//         {
//             UnityEngine.Debug.LogError($"Failed to save serialized Octree: {e.Message}");
//         }
//     }
//
//     private void StartBuildingTree(string versionHash)
//     {
//         if (isBuilding)
//         {
//             UnityEngine.Debug.LogWarning("Tree building is already in progress.");
//             return;
//         }
//
//         if (buildTreeCoroutine != null)
//         {
//             StopCoroutine(buildTreeCoroutine);
//         }
//         buildTreeCoroutine = StartCoroutine(BuildTreeOverTime(versionHash));
//     }
//     
//     private IEnumerator BuildTreeOverTime(string versionHash)
//     {
//         isBuilding = true;
//         int totalObjects = staticObjects.Count;
//         int processedObjects = 0;
//
//         NativeArray<float3> positions = new NativeArray<float3>(totalObjects, Allocator.TempJob);
//         NativeArray<float3> sizes = new NativeArray<float3>(totalObjects, Allocator.TempJob);
//         NativeArray<int> nodeIndices = new NativeArray<int>(totalObjects, Allocator.TempJob);
//
//         try
//         {
//             while (processedObjects < totalObjects)
//             {
//                 int objectsThisFrame = Mathf.Min(objectsPerFrame, totalObjects - processedObjects);
//
//                 for (int i = 0; i < objectsThisFrame; i++)
//                 {
//                     GameObject obj = staticObjects[processedObjects + i];
//                     if (obj != null)
//                     {
//                         positions[processedObjects + i] = obj.transform.position;
//                         sizes[processedObjects + i] = obj.GetComponent<Renderer>().bounds.size;
//                     }
//                     else
//                     {
//                         UnityEngine.Debug.LogWarning($"Null object found at index {processedObjects + i}");
//                         positions[processedObjects + i] = float3.zero;
//                         sizes[processedObjects + i] = float3.zero;
//                     }
//                 }
//
//                 processedObjects += objectsThisFrame;
//                 yield return null;
//             }
//
//             OctreeBuilderJob job = new OctreeBuilderJob
//             {
//                 Positions = positions,
//                 Sizes = sizes,
//                 NodeIndices = nodeIndices,
//                 TreeCenter = worldBounds.center,
//                 TreeSize = worldBounds.size,
//                 MaxDepth = 8 // You can adjust this based on your needs
//             };
//
//             JobHandle jobHandle = job.Schedule(totalObjects, maxJobBatchSize);
//             jobHandle.Complete();
//
//             octTree = new OctTree(worldBounds, lodDistances, versionHash);
//             octTree.InitializeTree(positions, sizes, nodeIndices);
//             octTree.SetObjects(staticObjects);
//
//             SaveSerializedTree();
//
//             UnityEngine.Debug.Log("Octree building completed and serialized.");
//         }
//         catch (Exception e)
//         {
//             UnityEngine.Debug.LogError($"Error during Octree building: {e.Message}");
//         }
//         finally
//         {
//             positions.Dispose();
//             sizes.Dispose();
//             nodeIndices.Dispose();
//             isBuilding = false;
//         }
//     }
//     
//     private void OnDestroy()
//     {
//         if (buildTreeCoroutine != null)
//         {
//             StopCoroutine(buildTreeCoroutine);
//         }
//     }
//
//     private void InitializeOctTree()
//     {
//         octTree = new OctTree(0, worldBounds, lodDistances);
//         
//         // Batch insert all static objects
//         GameObject[] staticObjects = GameObject.FindGameObjectsWithTag(staticObjectTag);
//         octTree.BatchInsert(staticObjects);
//
//         UnityEngine.Debug.Log($"Advanced Static LOD OctTree initialized with {staticObjects.Length} objects.");
//     }
//
//     void Update()
//     {
//         List<GameObject> visibleObjects = octTree.GetVisibleObjects(mainCamera, mainCamera.transform.position);
//
//         foreach (GameObject obj in visibleObjects)
//         {
//             // Additional processing if required
//         }
//     }
//
//     public bool AddObject(GameObject obj)
//     {
//         if (octTree.Insert(obj))
//         {
//             UnityEngine.Debug.Log($"Object {obj.name} added to the octree.");
//             return true;
//         }
//         UnityEngine.Debug.LogWarning($"Failed to add object {obj.name} to the octree.");
//         return false;
//     }
//
//     public bool RemoveObject(GameObject obj)
//     {
//         if (octTree.Remove(obj))
//         {
//             UnityEngine.Debug.Log($"Object {obj.name} removed from the octree.");
//             octTree.Rebalance();
//             return true;
//         }
//         UnityEngine.Debug.LogWarning($"Failed to remove object {obj.name} from the octree. Object not found in the tree.");
//         return false;
//     }
//
//     public void RebalanceTree()
//     {
//         octTree.Rebalance();
//         UnityEngine.Debug.Log("OctTree rebalanced.");
//     }
//
//     public void BatchAddObjects(IEnumerable<GameObject> objects)
//     {
//         octTree.BatchInsert(objects);
//         UnityEngine.Debug.Log($"Batch insertion completed. Tree rebalanced.");
//     }
//     
//     public void LogPerformanceMetrics()
//     {
//         UnityEngine.Debug.Log("OctTree Performance Metrics:");
//         UnityEngine.Debug.Log($"Last Full Rebuild Time: {lastFullRebuildTime}ms");
//         UnityEngine.Debug.Log($"Last Granular Update Time: {lastGranularUpdateTime}ms");
//         UnityEngine.Debug.Log($"Last Granular Update Node Count: {lastGranularUpdateNodeCount}");
//         
//         if (lastGranularUpdateNodeCount > 0)
//         {
//             float avgTimePerNode = (float)lastGranularUpdateTime / lastGranularUpdateNodeCount;
//             UnityEngine.Debug.Log($"Average Time per Updated Node: {avgTimePerNode:F2}ms");
//         }
//
//         UnityEngine.Debug.Log($"Total Full Rebuilds: {totalFullRebuilds}");
//         UnityEngine.Debug.Log($"Total Granular Updates: {totalGranularUpdates}");
//
//         if (totalFullRebuilds > 0)
//         {
//             float avgFullRebuildTime = (float)totalFullRebuildTime / totalFullRebuilds;
//             UnityEngine.Debug.Log($"Average Full Rebuild Time: {avgFullRebuildTime:F2}ms");
//         }
//
//         if (totalGranularUpdates > 0)
//         {
//             float avgGranularUpdateTime = (float)totalGranularUpdateTime / totalGranularUpdates;
//             UnityEngine.Debug.Log($"Average Granular Update Time: {avgGranularUpdateTime:F2}ms");
//         }
//
//         if (totalFullRebuilds > 0 && totalGranularUpdates > 0)
//         {
//             float fullRebuildToUpdateRatio = (float)totalFullRebuildTime / totalGranularUpdateTime;
//             UnityEngine.Debug.Log($"Full Rebuild to Granular Update Time Ratio: {fullRebuildToUpdateRatio:F2}");
//         }
//     }
//
//     // New method to reset performance metrics
//     public void ResetPerformanceMetrics()
//     {
//         lastFullRebuildTime = 0;
//         lastGranularUpdateTime = 0;
//         lastGranularUpdateNodeCount = 0;
//         totalFullRebuilds = 0;
//         totalGranularUpdates = 0;
//         totalFullRebuildTime = 0;
//         totalGranularUpdateTime = 0;
//         UnityEngine.Debug.Log("Performance metrics have been reset.");
//     }
//     
//     private void OnTreeUpdated(bool isFullRebuild)
//     {
//         if (debugMode)
//         {
//             LogPerformanceMetrics();
//         }
//     }
// }