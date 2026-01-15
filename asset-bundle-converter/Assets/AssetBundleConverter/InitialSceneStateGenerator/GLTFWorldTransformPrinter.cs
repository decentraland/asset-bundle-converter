using AssetBundleConverter.InitialSceneStateGenerator;
using Newtonsoft.Json;
using System.Linq;
using UnityEngine;
using System.Collections.Generic;
using UnityEditor;

namespace AssetBundleConverter.StaticSceneAssetBundle
{
    public class GltfTransformDumper
    {
        public static Matrix4x4 DumpGltfWorldTransforms(List<SceneComponent> components, int entityID)
        {
            Matrix4x4 worldMatrix = Matrix4x4.zero;

            var resolver = new WorldTransformResolver(components);
            var gltfContainers = components.Where(c => c.entityId == entityID);

            foreach (var gltf in gltfContainers)
            {
                int entityId = gltf.entityId;
                worldMatrix = resolver.GetWorldMatrix(entityId);

                /*
                Debug Info

                Vector3 worldPos = worldMatrix.GetColumn(3);

                // Rotation extraction
                Vector3 forward = worldMatrix.GetColumn(2); // Z axis
                Vector3 up = worldMatrix.GetColumn(1);      // Y axis
                Quaternion worldRot = Quaternion.LookRotation(forward, up);

                // Optional: scale extraction
                Vector3 scale = new Vector3(
                    worldMatrix.GetColumn(0).magnitude,
                    worldMatrix.GetColumn(1).magnitude,
                    worldMatrix.GetColumn(2).magnitude
                );

                Debug.Log($"Entity {entityId}:");
                Debug.Log($"  World Position: {worldPos}");
                Debug.Log($"  World Rotation (Quaternion): {worldRot}");
                Debug.Log($"  World Rotation (Euler): {worldRot.eulerAngles}");
                Debug.Log($"  World Scale: {scale}");
                Debug.Log($"  World Matrix:\n{worldMatrix}");
                */
            }
            return worldMatrix;
        }
    }
}
