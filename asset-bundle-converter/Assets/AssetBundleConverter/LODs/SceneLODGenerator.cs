using AssetBundleConverter.LODs;
using AssetBundleConverter.LODs.JsonParsing;
using Cysharp.Threading.Tasks;
using System.Collections.Generic;
using Unity.Plastic.Newtonsoft.Json;
using UnityEngine;

public class SceneLODGenerator {

    public async UniTask GenerateSceneLOD(Dictionary<string, string> lodContentTable)
    {
        TextAsset sceneDescriptorJson = Resources.Load<TextAsset>("rendereable-entities-manifest");
        SceneDescriptorData sceneDescriptor = JsonConvert.DeserializeObject<SceneDescriptorData>(sceneDescriptorJson.text);

        Dictionary<int, DCLRendereableEntity> renderableEntitiesDictionary = new Dictionary<int, DCLRendereableEntity>();
        foreach (var sceneDescriptorRenderableEntity in sceneDescriptor.RenderableEntities)
        {
            if (!renderableEntitiesDictionary.TryGetValue(sceneDescriptorRenderableEntity.entityId, out var dclEntity))
            {
                dclEntity = new DCLRendereableEntity();
                renderableEntitiesDictionary.Add(sceneDescriptorRenderableEntity.entityId, dclEntity);
            }
            dclEntity.SetComponentData(sceneDescriptorRenderableEntity);
        }

        foreach (var dclRendereableEntity in renderableEntitiesDictionary)
            dclRendereableEntity.Value.InitEntity();

        foreach (KeyValuePair<int, DCLRendereableEntity> dclRendereableEntity in renderableEntitiesDictionary)
            dclRendereableEntity.Value.PositionAndInstantiteMesh(lodContentTable, renderableEntitiesDictionary);

    }
}


