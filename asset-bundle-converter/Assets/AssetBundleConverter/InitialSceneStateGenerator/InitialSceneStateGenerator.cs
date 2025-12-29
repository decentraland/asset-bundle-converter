// unset:none
using AssetBundleConverter.StaticSceneAssetBundle;
using AssetBundleConverter.Wrappers.Interfaces;
using DCL;
using DCL.ABConverter;
using Newtonsoft.Json;
using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using UnityEditor;
using UnityEngine;

namespace AssetBundleConverter.InitialSceneStateGenerator
{
    public static class InitialSceneStateGenerator
    {

        private static Dictionary<string, HashSet<int>> gltfsComponents = new Dictionary<string, HashSet<int>>();
        private static List<string> textureComponents = new List<string>();
        private static List<SceneComponent> convertedJSONComponents = new List<SceneComponent>();
        private static Dictionary<int, bool> entityVisibility = new Dictionary<int, bool>();

        public static void PlaceAsset(string assetPath, GameObject prefab)
        {
            if (gltfsComponents.TryGetValue(assetPath, out HashSet<int> Component))
            {
                List<int> entityIds = Component.ToList();

                foreach (int entityId in entityIds)
                {
                    // Check if entity has visibility component and if it's not visible, skip instantiation entirely
                    if (entityVisibility.TryGetValue(entityId, out bool isVisible) && !isVisible)
                        continue;

                    // Create a new instance for each entity - this avoids scale accumulation
                    // and ensures each entity has its own GameObject
                    GameObject instancedGameObject = AssetInstantiator.InstanceGameObject(prefab);

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
                    Vector3 prefabPosition = instancedGameObject.transform.localPosition;
                    Quaternion prefabRotation = instancedGameObject.transform.localRotation;
                    Vector3 prefabScale = instancedGameObject.transform.localScale;

                    Vector3 finalPosition = jsonPosition + jsonRotation * prefabPosition;
                    Quaternion finalRotation = jsonRotation * prefabRotation;
                    Vector3 finalScale = Vector3.Scale(prefabScale, jsonScale);

                    UnityEngine.Debug.Log($"Entity {entityId} - {instancedGameObject.name}: prefab pos={prefabPosition}, JSON pos={jsonPosition}, final pos={finalPosition}, JSON scale={jsonScale}, final scale={finalScale}");

                    // Apply all transforms
                    instancedGameObject.transform.position = finalPosition;
                    instancedGameObject.transform.rotation = finalRotation;
                    instancedGameObject.transform.localScale = finalScale;
                }
            }
        }

        public static bool GenerateISSAssetBundle(Environment env, ContentServerUtils.EntityMappingsDTO entityDTO,
            List<AssetPath> assetPaths, Dictionary<string, IGltfImport> gltfImporters, string finalDownloadedPath)
        {
            if (IsInitialSceneStateCompatible(env, entityDTO))
            {
                string staticSceneABName = $"staticScene_{entityDTO.id}{PlatformUtils.GetPlatform()}";
                var asset = ScriptableObject.CreateInstance<StaticSceneDescriptor>();

                foreach (var assetPath in assetPaths)
                {
                    if (assetPath == null) continue;

                    if (assetPath.finalPath.EndsWith(".bin")) continue;

                    // Check if this asset matches a GltfContainer source
                    bool isStatic = gltfsComponents.ContainsKey(assetPath.filePath);
                    string assetBundleName = assetPath.hash + PlatformUtils.GetPlatform();

                    if (isStatic)
                    {
                        List<int> entityIds = gltfsComponents[assetPath.filePath].ToList();

                        foreach (int entityId in entityIds)
                        {
                            asset.assetHash.Add(assetPath.hash);
                            Matrix4x4 worldMatrix = GltfTransformDumper.DumpGltfWorldTransforms(convertedJSONComponents, entityId);
                            asset.positions.Add(worldMatrix.GetColumn(3));

                            // Rotation extraction
                            Vector3 forward = worldMatrix.GetColumn(2); // Z axis
                            Vector3 up = worldMatrix.GetColumn(1); // Y axis
                            asset.rotations.Add(Quaternion.LookRotation(forward, up));

                            // Optional: scale extraction
                            Vector3 scale = new Vector3(
                                worldMatrix.GetColumn(0).magnitude,
                                worldMatrix.GetColumn(1).magnitude,
                                worldMatrix.GetColumn(2).magnitude
                            );

                            asset.scales.Add(scale);
                        }

                        // Mark GLTF dependencies as static
                        if (gltfImporters.TryGetValue(assetPath.filePath, out IGltfImport gltfImport))
                        {
                            var dependencies = gltfImport.assetDependencies;

                            if (dependencies != null)
                            {
                                foreach (var dependency in dependencies)
                                {
                                    if (!string.IsNullOrEmpty(dependency.assetPath) && !dependency.assetPath.Contains("dcl/scene_ignore"))
                                        env.directory.MarkFolderForAssetBundleBuild(dependency.assetPath, staticSceneABName);
                                }
                            }
                        }

                    }

                    bool isStaticTexture = textureComponents.Contains(assetPath.filePath);
                    env.directory.MarkFolderForAssetBundleBuild(assetPath.finalPath, (isStatic || isStaticTexture) ? staticSceneABName : assetBundleName);
                }

                CreateStaticSceneDescriptor(asset, staticSceneABName, finalDownloadedPath);

                return true;
            }


            return false;
        }

        private static void CreateStaticSceneDescriptor(StaticSceneDescriptor asset, string staticSceneABName, string finalDownloadedPath)
        {
            string staticSceneDesriptorFilename = "StaticSceneDescriptor.json";
            string staticSceneDesciptorRelativePath = $"Assets/_Downloaded/{staticSceneDesriptorFilename}";
            //Export of StaticSceneDescriptor
            // Convert ScriptableObject to JSON using Newtonsoft.Json
            var settings = new JsonSerializerSettings
            {
                Formatting = Formatting.Indented,
                ReferenceLoopHandling = ReferenceLoopHandling.Ignore
            };

            string json = JsonConvert.SerializeObject(asset, settings);
            File.WriteAllText($"{finalDownloadedPath}/{staticSceneDesriptorFilename}", json);

            AssetDatabase.SaveAssets();
            AssetDatabase.Refresh();
            AssetImporter importer_json = AssetImporter.GetAtPath(staticSceneDesciptorRelativePath);
            importer_json.SetAssetBundleNameAndVariant(staticSceneABName, "");
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
                            entityVisibility[component.entityId] = visibilityData.visible;
                    }
                }
            }
        }

        private static bool IsInitialSceneStateCompatible(Environment env, ContentServerUtils.EntityMappingsDTO entityDTO)
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
            catch
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
