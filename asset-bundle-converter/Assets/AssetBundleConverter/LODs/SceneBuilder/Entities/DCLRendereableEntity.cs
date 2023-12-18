using AssetBundleConverter.LODs.JsonParsing;
using System.Collections.Generic;
using UnityEngine;

namespace AssetBundleConverter.LODs
{
    public class DCLRendereableEntity
    {

        private int entityID;
        private TransformData transform = new ();
        private DCLMesh rendereableMesh;
        private DCLMaterial dclMaterial;

        private GameObject instantiatedEntity;

        public void SetComponentData(RenderableEntity renderableEntity)
        {
            entityID = renderableEntity.entityId;

            switch (renderableEntity.componentName)
            {
                case RenderableEntityConstants.Transform:
                    transform = (TransformData)renderableEntity.data;
                    break;
                case RenderableEntityConstants.MeshRenderer:
                    rendereableMesh = ((MeshRendererData)renderableEntity.data).mesh;
                    break;
                case RenderableEntityConstants.GLTFContainer:
                    rendereableMesh = ((GLTFContainerData)renderableEntity.data).mesh;
                    break;
                case RenderableEntityConstants.Material:
                    dclMaterial = ((MaterialData)renderableEntity.data).material;
                    break;
            }
        }

        public void InitEntity()
        {
            instantiatedEntity = new GameObject();
            instantiatedEntity.name = $"Entity_{entityID}";
        }

        public void PositionAndInstantiteMesh(Dictionary<string, string> contentTable, Dictionary<int, DCLRendereableEntity> renderableEntities)
        {
            InstantiateTransform(renderableEntities);
            rendereableMesh?.InstantiateMesh(instantiatedEntity.transform, dclMaterial, contentTable);
        }

        private void InstantiateTransform(Dictionary<int, DCLRendereableEntity> renderableEntities)
        {
            if (transform.parent != 0)
                if (renderableEntities.TryGetValue((int)transform.parent, out DCLRendereableEntity rendereableEntity))
                    instantiatedEntity.transform.SetParent(rendereableEntity.instantiatedEntity.transform);

            instantiatedEntity.transform.localPosition = new Vector3(transform.position.x, transform.position.y, transform.position.z);
            instantiatedEntity.transform.localRotation = new Quaternion(transform.rotation.x, transform.rotation.y, transform.rotation.z, transform.rotation.w);
            instantiatedEntity.transform.localScale = new Vector3(transform.scale.x, transform.scale.y, transform.scale.z);
        }

    }
}


