using AssetBundleConverter.LODs.JsonParsing;
using System;
using System.Collections.Generic;
using UnityEngine;
using Mesh = UnityEngine.Mesh;

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

        public void InstantiateEntity(Dictionary<string, string> contentTable)
        {
            instantiatedEntity = new GameObject();
            instantiatedEntity.name = $"Entity_{entityID}";
            InstantiateTransform();
            rendereableMesh.InstantiateMesh(instantiatedEntity.transform, dclMaterial, contentTable);
        }

        private void InstantiateTransform()
        {
            instantiatedEntity.transform.position = new Vector3(transform.position.x, transform.position.y, transform.position.z);
            instantiatedEntity.transform.rotation = new Quaternion(transform.rotation.x, transform.rotation.y, transform.rotation.z, transform.rotation.w);
            instantiatedEntity.transform.localScale = new Vector3(transform.scale.x, transform.scale.y, transform.scale.z);
        }
    }
}


