using AssetBundleConverter.Wrappers.Interfaces;
using DCL;
using DCL.ABConverter;
using System.Collections.Generic;
using UnityEngine;

namespace AssetBundleConverter.InitialSceneStateGenerator
{
    /// <summary>
    /// Consumes a StaticSceneDescriptor.json (built upstream by lod-generator-unity)
    /// and uses it to (a) instantiate GLTFs at their world transforms during placement,
    /// and (b) mark a consolidated static asset bundle during conversion.
    ///
    /// The descriptor is keyed by asset content hash, so this class no longer needs to
    /// parse the scene manifest itself.
    /// </summary>
    public class InitialSceneStateGenerator
    {
        private const string DESCRIPTOR_PATH = "Assets/_Downloaded/StaticSceneDescriptor.json";

        private readonly Dictionary<string, List<StaticSceneAsset>> hashToTransforms
            = new Dictionary<string, List<StaticSceneAsset>>();

        private readonly Environment env;
        private readonly ContentServerUtils.EntityMappingsDTO entityDTO;

        public bool IsCompatible { get; private set; }

        public InitialSceneStateGenerator(Environment env, ContentServerUtils.EntityMappingsDTO entityDTO, bool enabled)
        {
            this.env = env;
            this.entityDTO = entityDTO;
            IsCompatible = enabled && TryLoadDescriptor();
        }

        private bool TryLoadDescriptor()
        {
            try
            {
                if (entityDTO.type?.ToLower() != "scene" || string.IsNullOrEmpty(entityDTO.id))
                    return false;

                if (!env.file.Exists(DESCRIPTOR_PATH))
                    return false;

                string json = env.file.ReadAllText(DESCRIPTOR_PATH);
                var descriptor = JsonUtility.FromJson<StaticSceneDescriptor>(json);
                if (descriptor?.assets == null || descriptor.assets.Count == 0)
                    return false;

                foreach (var entry in descriptor.assets)
                {
                    if (string.IsNullOrEmpty(entry.hash)) continue;
                    if (!hashToTransforms.TryGetValue(entry.hash, out var list))
                    {
                        list = new List<StaticSceneAsset>();
                        hashToTransforms[entry.hash] = list;
                    }
                    list.Add(entry);
                }

                return hashToTransforms.Count > 0;
            }
            catch
            {
                return false;
            }
        }

        /// <summary>
        /// No-op. Kept for call-site compatibility — the descriptor is the parsed state.
        /// </summary>
        public void GenerateInitialSceneState() { }

        /// <summary>
        /// Always instantiates the asset. If the descriptor has entries for this hash,
        /// places one instance per entry at the recorded world transform. Otherwise,
        /// creates a single instance at origin.
        /// </summary>
        public void InstantiateAsset(string assetHash, GameObject prefab)
        {
            if (IsCompatible && !string.IsNullOrEmpty(assetHash) && hashToTransforms.TryGetValue(assetHash, out var list))
            {
                foreach (var entry in list)
                    InstantiateWithTransform(prefab, entry);
            }
            else
            {
                AssetInstantiator.InstanceGameObject(prefab);
            }
        }

        /// <summary>
        /// Only places assets that appear in the descriptor. Use from editor placement tools.
        /// </summary>
        public void PlaceAssetFromManifest(string assetHash, GameObject prefab)
        {
            if (!IsCompatible) return;
            if (string.IsNullOrEmpty(assetHash)) return;
            if (!hashToTransforms.TryGetValue(assetHash, out var list)) return;

            foreach (var entry in list)
                InstantiateWithTransform(prefab, entry);
        }

        private static void InstantiateWithTransform(GameObject prefab, StaticSceneAsset entry)
        {
            GameObject instance = AssetInstantiator.InstanceGameObject(prefab);

            // Combine prefab's baked-in local transforms with the descriptor's world transforms,
            // preserving any internal GLTF position/rotation/scale offsets on the prefab root.
            Vector3 prefabPosition = instance.transform.localPosition;
            Quaternion prefabRotation = instance.transform.localRotation;
            Vector3 prefabScale = instance.transform.localScale;

            instance.transform.position = entry.position + entry.rotation * prefabPosition;
            instance.transform.rotation = entry.rotation * prefabRotation;
            instance.transform.localScale = Vector3.Scale(prefabScale, entry.scale);
        }

        /// <summary>
        /// Marks assets that appear in the descriptor as part of the consolidated
        /// staticScene_{sceneId} asset bundle; everything else gets its own per-hash bundle.
        /// </summary>
        public void GenerateISSAssetBundle(List<AssetPath> assetPaths, Dictionary<string, IGltfImport> gltfImporters, string finalDownloadedPath)
        {
            string staticSceneABName = $"staticScene_{entityDTO.id}{PlatformUtils.GetPlatform()}";

            // Track hashes that have been marked as static to prevent duplicate paths sharing a hash
            // (e.g., "models/win.glb" and "mini-game-assets/models/win.glb" with the same content hash —
            // only the path the descriptor referenced should drive the static marking).
            var hashesMarkedAsStatic = new HashSet<string>();

            foreach (var assetPath in assetPaths)
            {
                if (assetPath == null) continue;
                if (assetPath.finalPath.EndsWith(".bin")) continue;

                if (hashesMarkedAsStatic.Contains(assetPath.hash))
                    continue;

                bool isEmote = Utils.IsEmoteFileName(assetPath.fileName);
                bool isStatic = !isEmote && hashToTransforms.ContainsKey(assetPath.hash);
                string assetBundleName = assetPath.hash + PlatformUtils.GetPlatform();

                if (isStatic)
                {
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

                    hashesMarkedAsStatic.Add(assetPath.hash);
                }

                env.directory.MarkFolderForAssetBundleBuild(assetPath.finalPath, isStatic ? staticSceneABName : assetBundleName);
            }
        }
    }
}
