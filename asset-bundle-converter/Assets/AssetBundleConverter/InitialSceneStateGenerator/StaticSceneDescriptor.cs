using System;
using System.Collections.Generic;
using UnityEngine;

namespace AssetBundleConverter.InitialSceneStateGenerator
{
    [Serializable]
    public class StaticSceneDescriptor
    {
        public string sceneId;
        public List<StaticSceneAsset> assets = new List<StaticSceneAsset>();
    }

    [Serializable]
    public class StaticSceneAsset
    {
        public string hash;
        public Vector3 position;
        public Quaternion rotation;
        public Vector3 scale;
    }
}
