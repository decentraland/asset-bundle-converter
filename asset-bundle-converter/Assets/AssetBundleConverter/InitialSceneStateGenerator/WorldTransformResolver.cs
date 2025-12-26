using AssetBundleConverter.InitialSceneStateGenerator;
using UnityEngine;
using System.Collections.Generic;


namespace AssetBundleConverter.StaticSceneAssetBundle
{
    public class WorldTransformResolver
    {
        private readonly Dictionary<int, TransformData> transformMap;

        public WorldTransformResolver(List<SceneComponent> components)
        {
            transformMap = new Dictionary<int, TransformData>();
            foreach (var comp in components)
            {
                if (comp.componentName == "core::Transform" && comp.TryGetData<TransformData>(out var transformData))
                    transformMap[comp.entityId] = transformData;
            }
        }

        public Matrix4x4 GetWorldMatrix(int entityId)
        {
            if (!transformMap.TryGetValue(entityId, out var transform))
                return Matrix4x4.identity;

            Matrix4x4 localMatrix = Matrix4x4.TRS(
                transform.position,
                transform.rotation,
                transform.scale
            );

            if (transform.parent == 0 || transform.parent == entityId || !transformMap.ContainsKey(transform.parent))
                return localMatrix;

            return GetWorldMatrix(transform.parent) * localMatrix;
        }

    }
}
