// unset:none
using System;
using Unity.Plastic.Newtonsoft.Json;
using Unity.Plastic.Newtonsoft.Json.Linq;

namespace AssetBundleConverter.LODs.JsonParsing
{
    public class MaterialDataConverter : JsonConverter
    {
        public override bool CanConvert(Type objectType) =>
            (objectType == typeof(DCLMaterial));

        public override object ReadJson(JsonReader reader, Type objectType, object existingValue, JsonSerializer serializer)
        {
            JObject jsonObject = JObject.Load(reader);
            DCLMaterial dclMaterial = null;
            switch (jsonObject["$case"].Value<string>())
            {
                case MaterialConstants.PBR:
                    dclMaterial = new PBRMaterial();
                    serializer.Populate(jsonObject["pbr"].CreateReader(), dclMaterial);
                    break;
                case MaterialConstants.Unlit:
                    dclMaterial = new UnlitMaterial();
                    serializer.Populate(jsonObject["unlit"].CreateReader(), dclMaterial);
                    break;
            }
            return dclMaterial;
        }

        public override void WriteJson(JsonWriter writer, object value, JsonSerializer serializer)
        {
            throw new NotImplementedException();
        }
    }
}
