using System;
using System.Collections.Generic;
using Unity.Plastic.Newtonsoft.Json;

namespace AssetBundleConverter.LODs.JsonParsing
{
    public class SceneDescriptorData
    {
        [JsonProperty("scene-coords")]
        public List<int> SceneCoords;

        [JsonProperty("rendereable-entities")]
        public List<RenderableEntity> RenderableEntities;
    }

    [Serializable]
    [JsonConverter(typeof(RenderableEntityDataConverter))]
    public class RenderableEntity
    {
        public int entityId;
        public int componentId;
        public string componentName;
        public ComponentData data;
    }

    [Serializable]
    public abstract class ComponentData
    {

    }
}
