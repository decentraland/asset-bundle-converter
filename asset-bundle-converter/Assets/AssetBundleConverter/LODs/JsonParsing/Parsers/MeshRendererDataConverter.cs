using System;
using Unity.Plastic.Newtonsoft.Json;
using Unity.Plastic.Newtonsoft.Json.Linq;

namespace AssetBundleConverter.LODs.JsonParsing
{
    public class MeshRendererDataConverter : JsonConverter
    {
        public override bool CanConvert(Type objectType) =>
            (objectType == typeof(MeshRendererData));


        public override object ReadJson(JsonReader reader, Type objectType, object existingValue, JsonSerializer serializer)
        {
            JObject jsonObject = JObject.Load(reader);

            DCLMesh dclMesh = null;
            switch (jsonObject["$case"].Value<string>())
            {
                case MeshConstants.Box:
                    dclMesh = new Box();
                    serializer.Populate(jsonObject["box"].CreateReader(), dclMesh);
                    break;
                case MeshConstants.Cylinder:
                    dclMesh = new Cylinder();
                    serializer.Populate(jsonObject["cylinder"].CreateReader(), dclMesh);
                    break;
                case MeshConstants.Plane:
                    dclMesh = new Plane();
                    serializer.Populate(jsonObject["plane"].CreateReader(), dclMesh);
                    break;
                case MeshConstants.Sphere:
                    dclMesh = new Sphere();
                    serializer.Populate(jsonObject["sphere"].CreateReader(), dclMesh);
                    break;
            }

            return dclMesh;
        }


        public override void WriteJson(JsonWriter writer, object value, JsonSerializer serializer)
        {
            throw new NotImplementedException();
        }
    }
}
