// using UnityEngine;
// using Unity.Collections;
// using System;
// using System.Collections.Generic;
// using System.IO;
// using System.Runtime.Serialization.Formatters.Binary;
// using Unity.Mathematics;
// using System.Security.Cryptography;
// using System.Text;
//
// [System.Serializable]
// public class OctTree
// {
//     [System.Serializable]
//     private class OctreeNode
//     {
//         public Bounds bounds;
//         public List<int> objectIndices;
//         public OctreeNode[] children;
//         public string nodeHash;
//
//         public OctreeNode(Bounds bounds)
//         {
//             this.bounds = bounds;
//             this.objectIndices = new List<int>();
//             this.children = new OctreeNode[8];
//             this.nodeHash = "";
//         }
//         
//         public void UpdateNodeHash(List<GameObject> allObjects)
//         {
//             StringBuilder sb = new StringBuilder();
//             foreach (int index in objectIndices)
//             {
//                 GameObject obj = allObjects[index];
//                 sb.Append(obj.name);
//                 sb.Append(obj.transform.position.ToString());
//                 Renderer renderer = obj.GetComponent<Renderer>();
//                 if (renderer != null)
//                 {
//                     sb.Append(renderer.bounds.size.ToString());
//                 }
//             }
//             using (SHA256 sha256 = SHA256.Create())
//             {
//                 byte[] hashBytes = sha256.ComputeHash(Encoding.UTF8.GetBytes(sb.ToString()));
//                 nodeHash = BitConverter.ToString(hashBytes).Replace("-", "").Substring(0, 16);
//             }
//         }
//     }
//     
//     private const int MAX_OBJECTS = 10;
//     private const int MAX_LEVELS = 5;
//     private const float LARGE_OBJECT_THRESHOLD = 0.5f; // Objects larger than 50% of node size are considered large
//
//     //private int level;
//     private OctreeNode root;
//     private List<GameObject> allObjects; // Needs moving to HLOD object
//     public float[] lodDistances;
//     public string versionHash;
//     public Dictionary<string, string> componentHashes;
//
//     private List<GameObject> smallObjects; // Needs moving to HLOD object
//     private List<GameObject> largeObjects; // Needs moving to HLOD object
//
//     public OctTree(Bounds worldBounds, float[] lodDistances, string versionHash)
//     {
//         this.root = new OctreeNode(worldBounds);
//         this.lodDistances = lodDistances;
//         this.allObjects = new List<GameObject>();
//         this.versionHash = versionHash;
//         this.componentHashes = new Dictionary<string, string>();
//     }
//     
//     public byte[] Serialize()
//     {
//         using (MemoryStream ms = new MemoryStream())
//         {
//             BinaryFormatter formatter = new BinaryFormatter();
//             formatter.Serialize(ms, this);
//             return ms.ToArray();
//         }
//     }
//     
//     public static OctTree Deserialize(byte[] data)
//     {
//         using (MemoryStream ms = new MemoryStream(data))
//         {
//             BinaryFormatter formatter = new BinaryFormatter();
//             return (OctTree)formatter.Deserialize(ms);
//         }
//     }
//     
//     public void InitializeTree(NativeArray<float3> positions, NativeArray<float3> sizes, NativeArray<int> nodeIndices)
//     {
//         for (int i = 0; i < positions.Length; i++)
//         {
//             InsertObject(i, positions[i], sizes[i], nodeIndices[i]);
//         }
//         //UpdateAllNodeHashes();
//     }
//     
//     private void InsertObject(int objectIndex, float3 position, float3 size, int nodeIndex)
//     {
//         OctreeNode currentNode = root;
//         while (true)
//         {
//             if (nodeIndex == 0 || currentNode.children[0] == null)
//             {
//                 currentNode.objectIndices.Add(objectIndex);
//                 break;
//             }
//
//             int childIndex = nodeIndex % 8;
//             nodeIndex /= 8;
//
//             if (currentNode.children[childIndex] == null)
//             {
//                 Vector3 childSize = currentNode.bounds.size * 0.5f;
//                 Vector3 childCenter = currentNode.bounds.center + new Vector3(
//                     ((childIndex & 1) != 0) ? childSize.x * 0.5f : -childSize.x * 0.5f,
//                     ((childIndex & 2) != 0) ? childSize.y * 0.5f : -childSize.y * 0.5f,
//                     ((childIndex & 4) != 0) ? childSize.z * 0.5f : -childSize.z * 0.5f
//                 );
//                 currentNode.children[childIndex] = new OctreeNode(new Bounds(childCenter, childSize));
//             }
//
//             currentNode = currentNode.children[childIndex];
//         }
//     }
//     
//     private void UpdateAllNodeHashes()
//     {
//         UpdateNodeHashRecursive(root);
//     }
//     
//     private void UpdateNodeHashRecursive(OctreeNode node)
//     {
//         node.UpdateNodeHash(allObjects);
//         foreach (var child in node.children)
//         {
//             if (child != null)
//             {
//                 UpdateNodeHashRecursive(child);
//             }
//         }
//     }
//
//     // public void SetObjects(List<GameObject> objects)
//     // {
//     //     this.allObjects = objects;
//     // }
//     
//     public List<string> GetChangedNodes(OctTree newTree)
//     {
//         List<string> changedNodes = new List<string>();
//         CompareNodesRecursive(this.root, newTree.root, "", changedNodes);
//         return changedNodes;
//     }
//
//     private void CompareNodesRecursive(OctreeNode oldNode, OctreeNode newNode, string path, List<string> changedNodes)
//     {
//         if (oldNode.nodeHash != newNode.nodeHash)
//         {
//             changedNodes.Add(path);
//         }
//
//         for (int i = 0; i < 8; i++)
//         {
//             if (oldNode.children[i] != null && newNode.children[i] != null)
//             {
//                 CompareNodesRecursive(oldNode.children[i], newNode.children[i], path + i, changedNodes);
//             }
//             else if (oldNode.children[i] != null || newNode.children[i] != null)
//             {
//                 changedNodes.Add(path + i);
//             }
//         }
//     }
//     
//     public void UpdateNodes(List<string> nodePaths)
//     {
//         foreach (string path in nodePaths)
//         {
//             UpdateNodeByPath(path);
//         }
//     }
//
//     private void UpdateNodeByPath(string path)
//     {
//         OctreeNode node = root;
//         for (int i = 0; i < path.Length; i++)
//         {
//             int childIndex = int.Parse(path[i].ToString());
//             if (node.children[childIndex] == null)
//             {
//                 // Create the node if it doesn't exist
//                 Vector3 childSize = node.bounds.size * 0.5f;
//                 Vector3 childCenter = node.bounds.center + new Vector3(
//                     ((childIndex & 1) != 0) ? childSize.x * 0.5f : -childSize.x * 0.5f,
//                     ((childIndex & 2) != 0) ? childSize.y * 0.5f : -childSize.y * 0.5f,
//                     ((childIndex & 4) != 0) ? childSize.z * 0.5f : -childSize.z * 0.5f
//                 );
//                 node.children[childIndex] = new OctreeNode(new Bounds(childCenter, childSize));
//             }
//             node = node.children[childIndex];
//         }
//         node.UpdateNode(allObjects, MAX_OBJECTS_PER_NODE, MAX_TREE_DEPTH, path.Length);
//     }
//     
//     public bool Insert(GameObject obj)
//     {
//         if (!bounds.Intersects(obj.GetComponent<Renderer>().bounds))
//         {
//             return false;
//         }
//     
//         if (IsLargeObject(obj))
//         {
//             largeObjects.Add(obj);
//             return true;
//         }
//     
//         if (nodes[0] != null)
//         {
//             List<int> indices = GetIndices(obj.GetComponent<Renderer>().bounds);
//             bool inserted = false;
//             foreach (int index in indices)
//             {
//                 inserted |= nodes[index].Insert(obj);
//             }
//             return inserted;
//         }
//     
//         smallObjects.Add(obj);
//     
//         if (smallObjects.Count > MAX_OBJECTS && level < MAX_LEVELS)
//         {
//             Split();
//         }
//     
//         return true;
//     }
//
//     public void BatchInsert(IEnumerable<GameObject> objects)
//     {
//         foreach (var obj in objects)
//         {
//             Insert(obj);
//         }
//         Rebalance();
//     }
//
//     public bool Remove(GameObject obj)
//     {
//         if (!bounds.Intersects(obj.GetComponent<Renderer>().bounds))
//         {
//             return false;
//         }
//
//         if (largeObjects.Remove(obj))
//         {
//             return true;
//         }
//
//         if (nodes[0] != null)
//         {
//             List<int> indices = GetIndices(obj.GetComponent<Renderer>().bounds);
//             bool removed = false;
//             foreach (int index in indices)
//             {
//                 removed |= nodes[index].Remove(obj);
//             }
//             return removed;
//         }
//
//         return smallObjects.Remove(obj);
//     }
//
//     private void Split()
//     {
//         Vector3 subSize = bounds.size / 2f;
//         Vector3 center = bounds.center;
//
//         for (int i = 0; i < 8; i++)
//         {
//             Vector3 newCenter = center;
//             newCenter.x += (i & 1) == 0 ? subSize.x / 2 : -subSize.x / 2;
//             newCenter.y += (i & 2) == 0 ? subSize.y / 2 : -subSize.y / 2;
//             newCenter.z += (i & 4) == 0 ? subSize.z / 2 : -subSize.z / 2;
//
//             nodes[i] = new OctTree(level + 1, new Bounds(newCenter, subSize), lodDistances);
//         }
//
//         List<GameObject> objectsToReinsert = new List<GameObject>(smallObjects);
//         smallObjects.Clear();
//
//         foreach (var obj in objectsToReinsert)
//         {
//             List<int> indices = GetIndices(obj.GetComponent<Renderer>().bounds);
//             foreach (int index in indices)
//             {
//                 nodes[index].Insert(obj);
//             }
//         }
//     }
//
//     private List<int> GetIndices(Bounds objBounds)
//     {
//         List<int> indices = new List<int>();
//         Vector3 center = bounds.center;
//
//         bool rightOfLeft = objBounds.max.x > center.x - bounds.extents.x;
//         bool leftOfRight = objBounds.min.x < center.x + bounds.extents.x;
//         bool aboveBottom = objBounds.max.y > center.y - bounds.extents.y;
//         bool belowTop = objBounds.min.y < center.y + bounds.extents.y;
//         bool inFrontOfBack = objBounds.max.z > center.z - bounds.extents.z;
//         bool behindFront = objBounds.min.z < center.z + bounds.extents.z;
//
//         for (int i = 0; i < 8; i++)
//         {
//             bool inThisOctant = true;
//
//             if (((i & 1) == 0 && !rightOfLeft) || ((i & 1) == 1 && !leftOfRight))
//                 inThisOctant = false;
//             if (((i & 2) == 0 && !aboveBottom) || ((i & 2) == 2 && !belowTop))
//                 inThisOctant = false;
//             if (((i & 4) == 0 && !inFrontOfBack) || ((i & 4) == 4 && !behindFront))
//                 inThisOctant = false;
//
//             if (inThisOctant)
//                 indices.Add(i);
//         }
//
//         return indices;
//     }
//
//     private bool IsLargeObject(GameObject obj)
//     {
//         Bounds objBounds = obj.GetComponent<Renderer>().bounds;
//         return objBounds.size.x > bounds.size.x * LARGE_OBJECT_THRESHOLD ||
//                objBounds.size.y > bounds.size.y * LARGE_OBJECT_THRESHOLD ||
//                objBounds.size.z > bounds.size.z * LARGE_OBJECT_THRESHOLD;
//     }
//
//     public void Rebalance()
//     {
//         if (nodes[0] != null)
//         {
//             for (int i = 0; i < 8; i++)
//             {
//                 nodes[i].Rebalance();
//             }
//
//             int totalObjects = nodes.Sum(n => n.GetTotalObjects());
//             if (totalObjects <= MAX_OBJECTS)
//             {
//                 MergeChildren();
//             }
//         }
//         else if (smallObjects.Count > MAX_OBJECTS && level < MAX_LEVELS)
//         {
//             Split();
//         }
//     }
//
//     private void MergeChildren()
//     {
//         for (int i = 0; i < 8; i++)
//         {
//             smallObjects.AddRange(nodes[i].smallObjects);
//             largeObjects.AddRange(nodes[i].largeObjects);
//             nodes[i] = null;
//         }
//     }
//
//     private int GetTotalObjects()
//     {
//         return smallObjects.Count + largeObjects.Count + (nodes[0] != null ? nodes.Sum(n => n.GetTotalObjects()) : 0);
//     }
//
//     public List<GameObject> GetVisibleObjects(Camera camera, Vector3 cameraPosition)
//     {
//         List<GameObject> visibleObjects = new List<GameObject>();
//         GetVisibleObjectsRecursive(camera, cameraPosition, visibleObjects);
//         return visibleObjects;
//     }
//
//     private void GetVisibleObjectsRecursive(Camera camera, Vector3 cameraPosition, List<GameObject> visibleObjects)
//     {
//         if (!IsVisibleToCamera(camera))
//         {
//             return;
//         }
//
//         float distanceToCamera = Vector3.Distance(cameraPosition, bounds.center);
//         int lodLevel = GetLODLevel(distanceToCamera);
//
//         // Check large objects
//         foreach (GameObject obj in largeObjects)
//         {
//             if (IsObjectVisible(obj, camera))
//             {
//                 visibleObjects.Add(obj);
//                 SetLODForObject(obj, lodLevel);
//             }
//         }
//
//         if (lodLevel == level || nodes[0] == null)
//         {
//             foreach (GameObject obj in smallObjects)
//             {
//                 if (IsObjectVisible(obj, camera))
//                 {
//                     visibleObjects.Add(obj);
//                     SetLODForObject(obj, lodLevel);
//                 }
//             }
//         }
//         else if (nodes[0] != null)
//         {
//             for (int i = 0; i < 8; i++)
//             {
//                 nodes[i].GetVisibleObjectsRecursive(camera, cameraPosition, visibleObjects);
//             }
//         }
//     }
//
//     private bool IsVisibleToCamera(Camera camera)
//     {
//         Plane[] frustumPlanes = GeometryUtility.CalculateFrustumPlanes(camera);
//         return GeometryUtility.TestPlanesAABB(frustumPlanes, bounds);
//     }
//
//     private bool IsObjectVisible(GameObject obj, Camera camera)
//     {
//         Renderer renderer = obj.GetComponent<Renderer>();
//         return renderer != null && renderer.isVisible;
//     }
//
//     private int GetLODLevel(float distance)
//     {
//         for (int i = 0; i < lodDistances.Length; i++)
//         {
//             if (distance <= lodDistances[i])
//             {
//                 return i;
//             }
//         }
//         return lodDistances.Length - 1;
//     }
//
//     private void SetLODForObject(GameObject obj, int lodLevel)
//     {
//         LODGroup lodGroup = obj.GetComponent<LODGroup>();
//         if (lodGroup != null)
//         {
//             lodGroup.ForceLOD(lodLevel);
//         }
//     }
//     
//     public void DrawDebugGizmos(bool drawBounds, bool drawObjects, LayerMask layerMask)
//     {
//         if (drawBounds)
//         {
//             Gizmos.color = new Color(1, 1, 1, 0.5f); // Semi-transparent white
//             Gizmos.DrawWireCube(bounds.center, bounds.size);
//         }
//
//         if (drawObjects)
//         {
//             DrawObjectsGizmos(smallObjects, Color.green, 0.1f, layerMask);
//             DrawObjectsGizmos(largeObjects, Color.red, 0.2f, layerMask);
//         }
//
//         if (nodes[0] != null)
//         {
//             foreach (var node in nodes)
//             {
//                 node.DrawDebugGizmos(drawBounds, drawObjects, layerMask);
//             }
//         }
//     }
//     
//     private void DrawObjectsGizmos(List<GameObject> objects, Color color, float size, LayerMask layerMask)
//     {
//         Gizmos.color = color;
//         foreach (var obj in objects)
//         {
//             if (obj != null && ((1 << obj.layer) & layerMask) != 0)
//             {
//                 Gizmos.DrawSphere(obj.transform.position, size);
//             }
//         }
//     }
//     
//     public void DrawLODLevels(Camera camera, Vector3 cameraPosition)
//     {
//         float distanceToCamera = Vector3.Distance(cameraPosition, bounds.center);
//         int lodLevel = GetLODLevel(distanceToCamera);
//
//         Color lodColor = GetLODColor(lodLevel);
//         Gizmos.color = lodColor;
//         Gizmos.DrawWireCube(bounds.center, bounds.size);
//
//         if (nodes[0] != null)
//         {
//             foreach (var node in nodes)
//             {
//                 node.DrawLODLevels(camera, cameraPosition);
//             }
//         }
//     }
//
//     private Color GetLODColor(int lodLevel)
//     {
//         switch (lodLevel)
//         {
//             case 0: return Color.red;    // Highest detail
//             case 1: return Color.yellow;
//             case 2: return Color.green;
//             case 3: return Color.blue;
//             default: return Color.gray;  // Lowest detail
//         }
//     }
//     
//     public TreeStatistics GetTreeStatistics()
//     {
//         TreeStatistics stats = new TreeStatistics();
//         CollectStatistics(stats, 0);
//         return stats;
//     }
//
//     private void CollectStatistics(TreeStatistics stats, int depth)
//     {
//         stats.TotalNodes++;
//         stats.MaxDepth = Mathf.Max(stats.MaxDepth, depth);
//         stats.TotalObjects += smallObjects.Count + largeObjects.Count;
//         stats.ObjectsPerLevel[depth] = (stats.ObjectsPerLevel.ContainsKey(depth) ? stats.ObjectsPerLevel[depth] : 0) + smallObjects.Count + largeObjects.Count;
//
//         if (nodes[0] != null)
//         {
//             foreach (var node in nodes)
//             {
//                 node.CollectStatistics(stats, depth + 1);
//             }
//         }
//         else
//         {
//             stats.LeafNodes++;
//         }
//     }
// }