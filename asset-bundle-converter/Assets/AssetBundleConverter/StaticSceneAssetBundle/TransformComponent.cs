using System.Collections.Generic;
using UnityEngine;

namespace AssetBundleConverter.StaticSceneAssetBundle
{
    public class SceneComponent
    {
        public int entityId;
        public int componentId;
        public string componentName;
        public TransformData data; // Will be null for non-Transform components
    }

    public class TransformData
    {
        public Vector3 position;
        public Quaternion rotation;
        public Vector3 scale;
        public int parent;
    }
}
