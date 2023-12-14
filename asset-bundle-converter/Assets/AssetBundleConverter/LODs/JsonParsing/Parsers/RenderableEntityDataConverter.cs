// unset:none
using System;
using Unity.Plastic.Newtonsoft.Json;
using Unity.Plastic.Newtonsoft.Json.Linq;

namespace AssetBundleConverter.LODs.JsonParsing
{
    public class RenderableEntityDataConverter : JsonConverter
    {
        public override bool CanConvert(Type objectType) =>
            (objectType == typeof(RenderableEntity));

        public override object ReadJson(JsonReader reader, Type objectType, object existingValue, JsonSerializer serializer)
        {
            JObject jsonObject = JObject.Load(reader);

            RenderableEntity renderableEntity = new RenderableEntity();
            renderableEntity.entityId = jsonObject["entityId"].Value<int>();
            renderableEntity.componentName = jsonObject["componentName"].Value<string>();
            renderableEntity.componentId = jsonObject["componentId"].Value<int>();

            ComponentData componentData = null;
            switch (renderableEntity.componentName)
            {
                case RenderableEntityConstants.Transform:
                    componentData = new TransformData();
                    break;
                case RenderableEntityConstants.Material:
                    componentData = new MaterialData();
                    break;
                case RenderableEntityConstants.GLTFContainer:
                   componentData = new GLTFContainerData(new DCLGLTFMesh(jsonObject["data"]["src"].Value<string>()));
                   break;
                case RenderableEntityConstants.MeshRenderer:
                    componentData = new MeshRendererData();
                    break;
            }

            if (componentData != null)
                serializer.Populate(jsonObject["data"].CreateReader(), componentData);

            renderableEntity.data = componentData;

            return renderableEntity;
        }

        public override void WriteJson(JsonWriter writer, object value, JsonSerializer serializer)
        {
            throw new NotImplementedException();
        }
    }
}
