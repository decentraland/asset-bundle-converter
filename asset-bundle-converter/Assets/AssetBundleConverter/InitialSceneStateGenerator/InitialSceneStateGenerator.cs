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
    public class InitialSceneStateGenerator
    {
        private Dictionary<string, HashSet<int>> gltfsComponents = new Dictionary<string, HashSet<int>>();
        private List<string> textureComponents = new List<string>();
        private List<SceneComponent> convertedJSONComponents = new List<SceneComponent>();
        private Dictionary<int, bool> entityVisibility = new Dictionary<int, bool>();

        private readonly Environment env;
        private readonly ContentServerUtils.EntityMappingsDTO entityDTO;

        /// <summary>
        /// Whether this scene has a compatible manifest for initial scene state generation
        /// </summary>
        public bool IsCompatible { get; private set; }

        /// <summary>
        /// Creates a new InitialSceneStateGenerator and checks compatibility once
        /// </summary>
        public InitialSceneStateGenerator(Environment env, ContentServerUtils.EntityMappingsDTO entityDTO)
        {
            this.env = env;
            this.entityDTO = entityDTO;
            IsCompatible = TryLoadManifest();
        }

        private bool TryLoadManifest()
        {
            try
            {
                string manifestPath = $"Assets/_SceneManifest/{entityDTO.id}-lod-manifest.json";

                if (entityDTO.type?.ToLower() == "scene" && !string.IsNullOrEmpty(entityDTO.id) && env.file.Exists(manifestPath))
                {
                    convertedJSONComponents = JsonConvert.DeserializeObject<List<SceneComponent>>(env.file.ReadAllText(manifestPath));
                    return convertedJSONComponents != null;
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

        /// <summary>
        /// Always instantiates the asset. If manifest data exists, places instances at their defined transforms.
        /// If not in manifest, creates a single instance at origin.
        /// Use this from AssetBundleConverter where all assets must be instantiated.
        /// We dont care about visibility on this path
        /// </summary>
        public void InstantiateAsset(string assetPath, GameObject prefab)
        {
            // Check if this asset has placement data in the manifest
            // Also check for prefab version in case MeshBaker replaced the original GLTF
            HashSet<int> Component = null;
            bool hasManifestData = false;
            
            if (IsCompatible)
            {
                if (gltfsComponents.TryGetValue(assetPath, out Component))
                {
                    hasManifestData = true;
                }
                else if (TryGetGltfKeyForPrefab(assetPath, out string gltfKey))
                {
                    Component = gltfsComponents[gltfKey];
                    hasManifestData = true;
                }
            }
            
            if (hasManifestData && Component != null)
            {
                List<int> entityIds = Component.ToList();

                foreach (int entityId in entityIds)
                    InstantiateWithTransform(prefab, entityId);
            }
            else
            {
                // No manifest data - create a single instance at origin
                AssetInstantiator.InstanceGameObject(prefab);
            }
        }

        /// <summary>
        /// Only places assets that exist in the manifest with valid transforms.
        /// Respects visibility - invisible entities are skipped entirely.
        /// Use this from ScenePlacementEditor for manifest-driven placement only.
        /// </summary>
        public void PlaceAssetFromManifest(string assetPath, GameObject prefab, bool firstInstanceOnly = false)
        {
            if (!IsCompatible) return;

            // Check both original path and prefab path (in case MeshBaker replaced the GLTF)
            HashSet<int> Component = null;
            if (gltfsComponents.TryGetValue(assetPath, out Component))
            {
                // Found with original path
            }
            else if (TryGetGltfKeyForPrefab(assetPath, out string gltfKey))
            {
                Component = gltfsComponents[gltfKey];
            }
            else
            {
                return; // Not found
            }

            List<int> entityIds = Component.ToList();

            foreach (int entityId in entityIds)
            {
                // Skip invisible entities entirely
                if (entityVisibility.TryGetValue(entityId, out bool isVisible) && !isVisible)
                    continue;

                InstantiateWithTransform(prefab, entityId);

                // If only first instance is requested, break after placing one
                if (firstInstanceOnly)
                    return;
            }
        }

        /// <summary>
        /// Creates an instance of the prefab and applies the transform from the manifest for the given entity.
        /// </summary>
        private void InstantiateWithTransform(GameObject prefab, int entityId)
        {
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

            // Apply all transforms
            instancedGameObject.transform.position = finalPosition;
            instancedGameObject.transform.rotation = finalRotation;
            instancedGameObject.transform.localScale = finalScale;
        }

        public void GenerateISSAssetBundle(List<AssetPath> assetPaths, Dictionary<string, IGltfImport> gltfImporters, string finalDownloadedPath)
        {
            string staticSceneABName = $"staticScene_{entityDTO.id}{PlatformUtils.GetPlatform()}";
            var asset = ScriptableObject.CreateInstance<StaticSceneDescriptor>();

            foreach (var assetPath in assetPaths)
            {
                if (assetPath == null) continue;

                if (assetPath.finalPath.EndsWith(".bin")) continue;

                // Check if this asset matches a GltfContainer source
                // Also check for .prefab version in case MeshBaker replaced the original GLTF
                bool isStatic = gltfsComponents.ContainsKey(assetPath.filePath) ||
                                TryGetGltfKeyForPrefab(assetPath.filePath, out _);
                string assetBundleName = assetPath.hash + PlatformUtils.GetPlatform();

                if (isStatic)
                {
                    // Get entity IDs - check both original path and prefab path
                    string gltfKey = gltfsComponents.ContainsKey(assetPath.filePath) 
                        ? assetPath.filePath 
                        : (TryGetGltfKeyForPrefab(assetPath.filePath, out string foundKey) ? foundKey : assetPath.filePath);
                    List<int> entityIds = gltfsComponents[gltfKey].ToList();

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
        }

        private void CreateStaticSceneDescriptor(StaticSceneDescriptor asset, string staticSceneABName, string finalDownloadedPath)
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

        /// <summary>
        /// Parses the manifest and builds the component maps for GLTF containers, textures, and visibility
        /// </summary>
        public void GenerateInitialSceneState()
        {
            if (!IsCompatible) return;

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

        /// <summary>
        /// Gets the parsed JSON components (for external use if needed)
        /// </summary>
        public List<SceneComponent> GetConvertedJSONComponents() => convertedJSONComponents;

        /// <summary>
        /// Checks if a prefab file path corresponds to an original GLTF/GLB in the gltfsComponents dictionary.
        /// This handles the case where MeshBaker replaced the original GLTF with a baked prefab.
        /// </summary>
        private bool TryGetGltfKeyForPrefab(string prefabPath, out string gltfKey)
        {
            gltfKey = null;
            
            if (!prefabPath.EndsWith(".prefab", StringComparison.OrdinalIgnoreCase))
                return false;

            // Try to find a matching GLTF/GLB key by replacing .prefab with common model extensions
            string basePath = prefabPath.Substring(0, prefabPath.Length - 7); // Remove ".prefab"
            
            string[] gltfExtensions = { ".glb", ".gltf", ".GLB", ".GLTF" };
            
            foreach (var ext in gltfExtensions)
            {
                string potentialKey = basePath + ext;
                if (gltfsComponents.ContainsKey(potentialKey))
                {
                    gltfKey = potentialKey;
                    return true;
                }
            }
            
            return false;
        }
    }
}
