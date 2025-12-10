// unset:none
using AssetBundleConverter.StaticSceneAssetBundle;
using AssetBundleConverter.Wrappers.Interfaces;
using DCL;
using DCL.ABConverter;
using Newtonsoft.Json;
using System;
using System.Collections.Generic;
using System.Linq;
using UnityEditor;
using UnityEngine;

namespace AssetBundleConverter
{
    public static class InitialSceneStateGenerator
    {

        private static Dictionary<string, HashSet<int>> gltfsComponents = new Dictionary<string, HashSet<int>>();
        private static List<string> textureComponents = new List<string>();
        private static List<SceneComponent> convertedJSONComponents = new List<SceneComponent>();
        private static Dictionary<int, bool> entityVisibility = new Dictionary<int, bool>();


        private static GameObject InstanceGameObject(GameObject originalGLTF)
        {
            GameObject clone = (GameObject)PrefabUtility.InstantiatePrefab(originalGLTF);
            var renderers = clone.GetComponentsInChildren<Renderer>(true);

            foreach (Renderer renderer in renderers)
            {
                if (renderer.name.ToLower().Contains("_collider"))
                {
                    renderer.enabled = false;
                }
                if (renderer.sharedMaterial == null || renderer.sharedMaterials == null || renderer.sharedMaterials.Length == 0)
                {
                    renderer.enabled = false;
                }
            }
            return clone;
        }

        public static void PlaceAsset(string assetPath, GameObject originalGLTF)
        {
            if (gltfsComponents.TryGetValue(assetPath, out HashSet<int> Component))
            {
                List<int> entityIds = Component.ToList();

                foreach (int entityId in entityIds)
                {
                    // Check if entity has visibility component and if it's not visible, skip instantiation
                    if (entityVisibility.TryGetValue(entityId, out bool isVisible) && !isVisible)
                    {
                        continue;
                    }

                    GameObject clone = InstanceGameObject(originalGLTF);

                    Matrix4x4 worldMatrix = GltfTransformDumper.DumpGltfWorldTransforms(convertedJSONComponents, entityId);

                    // Extract transforms from JSON world matrix
                    Vector3 jsonPosition = worldMatrix.GetColumn(3);

                    Vector3 forward = worldMatrix.GetColumn(2); // Z axis
                    Vector3 up = worldMatrix.GetColumn(1); // Y axis
                    Quaternion jsonRotation = Quaternion.LookRotation(forward, up);

                    Vector3 jsonScale = new Vector3(
                        worldMatrix.GetColumn(0).magnitude,
                        worldMatrix.GetColumn(1).magnitude,
                        worldMatrix.GetColumn(2).magnitude
                    );

                    // Combine prefab's baked-in transforms with JSON transforms
                    // This preserves any internal GLTF position/rotation/scaling offsets
                    Vector3 prefabPosition = originalGLTF.transform.localPosition;
                    Quaternion prefabRotation = originalGLTF.transform.localRotation;
                    Vector3 prefabScale = originalGLTF.transform.localScale;

                    Vector3 finalPosition = jsonPosition + jsonRotation * prefabPosition;
                    Quaternion finalRotation = jsonRotation * prefabRotation;
                    Vector3 finalScale = Vector3.Scale(prefabScale, jsonScale);

                    UnityEngine.Debug.Log($"Entity {entityId} - {originalGLTF.name}: prefab pos={prefabPosition}, JSON pos={jsonPosition}, final pos={finalPosition}");

                    // Apply all transforms
                    clone.transform.position = finalPosition;
                    clone.transform.rotation = finalRotation;
                    clone.transform.localScale = finalScale;
                }
            }
            else
            {
                //For now, I dont want to isntantiate
                //InstanceGameObject(originalGLTF);
            }

        }

        public static void GenerateInitialSceneState(Environment env, ContentServerUtils.EntityMappingsDTO entityDTO)
        {
            if (IsInitialSceneStateCompatible(env, entityDTO))
            {
                //TODO (JUANI): There is a bug in the Asset Manifest generator. The entity could be twice, therefore generating
                //multiple copies of the same asset. By doing this, we ensure that there is only one
                gltfsComponents = new Dictionary<string, HashSet<int>>();
                textureComponents = new List<string>();
                entityVisibility = new Dictionary<int, bool>();

                foreach (var component in convertedJSONComponents)
                {
                    if (component.componentName == "core::GltfContainer")
                    {
                        if (component.TryGetData<MeshRendererData>(out var meshData) && !string.IsNullOrEmpty(meshData.src))
                        {
                            if (!gltfsComponents.ContainsKey(meshData.src))
                                gltfsComponents.Add(meshData.src, new HashSet<int>());

                            gltfsComponents[meshData.src].Add(component.entityId);
                        }
                    }
                    else if (component.componentName == "core::Material")
                    {
                        if (component.TryGetData<MaterialComponentData>(out var materialData))
                        {
                            var textureSources = materialData.GetAllTextureSources();
                            textureComponents.AddRange(textureSources);
                        }
                    }
                    else if (component.componentName == "core::VisibilityComponent")
                    {
                        if (component.TryGetData<VisibilityData>(out var visibilityData))
                        {
                            entityVisibility[component.entityId] = visibilityData.visible;
                        }
                    }
                }
            }
        }

        public static bool IsInitialSceneStateCompatible(Environment env, ContentServerUtils.EntityMappingsDTO entityDTO)
        {
            //Manifest was created before the Unity iteration ran
            try
            {
                string manifestPath = $"Assets/_SceneManifest/{entityDTO.id}-lod-manifest.json";

                if (entityDTO.type.ToLower() == "scene" && !string.IsNullOrEmpty(entityDTO.id) && env.file.Exists(manifestPath))
                {
                    convertedJSONComponents = JsonConvert.DeserializeObject<List<SceneComponent>>(env.file.ReadAllText(manifestPath));
                    return true;
                }

                convertedJSONComponents = null;
                return false;
            }
            catch (Exception e)
            {
                convertedJSONComponents = null;
                return false;
            }
        }

        public static bool IsInitialSceneStateCompatible(Environment env, ContentServerUtils.EntityMappingsDTO entityDTO, out List<SceneComponent> convertedJSONComponents)
        {
            //Manifest was created before the Unity iteration ran
            try
            {
                string manifestPath = $"Assets/_SceneManifest/{entityDTO.id}-lod-manifest.json";

                if (entityDTO.type.ToLower() == "scene" && !string.IsNullOrEmpty(entityDTO.id) && env.file.Exists(manifestPath))
                {
                    convertedJSONComponents = JsonConvert.DeserializeObject<List<SceneComponent>>(env.file.ReadAllText(manifestPath));
                    return true;
                }

                convertedJSONComponents = null;
                return false;
            }
            catch (Exception e)
            {
                convertedJSONComponents = null;
                return false;
            }
        }

    }
}
