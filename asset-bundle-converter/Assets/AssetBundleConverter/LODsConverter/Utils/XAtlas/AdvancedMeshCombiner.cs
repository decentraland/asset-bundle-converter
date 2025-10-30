using UnityEngine;
using UnityEditor;
using System.Collections.Generic;
using System.Linq;
using System.IO;

namespace AssetBundleConverter.LODsConverter.Utils
{
    public class AdvancedMeshCombiner
    {
        [System.Serializable]
        public class AtlasSettings
        {
            public int atlasSize = 2048;
            public int padding = 2;
            public FilterMode filterMode = FilterMode.Bilinear;
            public TextureFormat format = TextureFormat.DXT1;
            public bool generateMipmaps = true;
            public string outputPath = "Assets/Generated/Atlases/";
        }

        public static GameObject CombineWithAtlasing(GameObject[] objects, AtlasSettings settings = null)
        {
            if (settings == null) settings = new AtlasSettings();

            // Group meshes by material compatibility (shader + properties, ignoring textures)
            var materialGroups = GroupMeshesByCompatibility(objects);

            GameObject combinedParent = new GameObject("CombinedMeshes_WithAtlas");

            foreach (var group in materialGroups)
            {
                if (group.Value.Count > 1) { CombineMeshGroupWithAtlas(group.Key, group.Value, combinedParent, settings); }
            }

            return combinedParent;
        }

        private static Dictionary<MaterialSignature, List<MeshData>> GroupMeshesByCompatibility(GameObject[] objects)
        {
            var groups = new Dictionary<MaterialSignature, List<MeshData>>();

            foreach (var obj in objects)
            {
                var renderer = obj.GetComponent<MeshRenderer>();
                var filter = obj.GetComponent<MeshFilter>();

                if (renderer == null || filter == null) continue;
                if (IsAnimated(obj)) continue;

                foreach (var material in renderer.sharedMaterials)
                {
                    if (material == null) continue;

                    var signature = new MaterialSignature(material);

                    if (!groups.ContainsKey(signature))
                        groups[signature] = new List<MeshData>();

                    groups[signature]
                       .Add(new MeshData
                        {
                            mesh = filter.sharedMesh,
                            transform = obj.transform,
                            renderer = renderer,
                            material = material,
                            submeshIndex = System.Array.IndexOf(renderer.sharedMaterials, material)
                        });
                }
            }

            return groups;
        }

        private static void CombineMeshGroupWithAtlas(MaterialSignature signature, List<MeshData> meshes,
            GameObject parent, AtlasSettings settings)
        {
            // Extract unique textures and materials
            var uniqueMaterials = meshes.Select(m => m.material).Distinct().ToList();

            // Create atlas if we have multiple different textures
            Material atlasMaterial;
            Dictionary<Material, Rect> uvRects;

            if (uniqueMaterials.Count > 1 && HasDifferentTextures(uniqueMaterials)) { atlasMaterial = CreateTextureAtlas(uniqueMaterials, signature, settings, out uvRects); }
            else
            {
                // Use original material if textures are the same
                atlasMaterial = uniqueMaterials[0];
                uvRects = uniqueMaterials.ToDictionary(m => m, m => new Rect(0, 0, 1, 1));
            }

            // Combine meshes with UV remapping
            CombineMeshesWithUVRemapping(meshes, atlasMaterial, uvRects, parent);
        }

        private static bool HasDifferentTextures(List<Material> materials)
        {
            var firstTexture = materials[0].mainTexture;
            return materials.Any(m => m.mainTexture != firstTexture);
        }

        private static Material CreateTextureAtlas(List<Material> materials, MaterialSignature signature,
            AtlasSettings settings, out Dictionary<Material, Rect> uvRects)
        {
            // Extract textures for atlasing
            var textureData = ExtractTextureData(materials);

            // Create atlas texture
            var atlas = new Texture2D(settings.atlasSize, settings.atlasSize, settings.format, settings.generateMipmaps);
            var rects = atlas.PackTextures(textureData.textures.ToArray(), settings.padding);

            atlas.filterMode = settings.filterMode;
            atlas.name = $"Atlas_{signature.GetHashCode()}";

            // Save atlas to disk
            SaveAtlasTexture(atlas, settings.outputPath, atlas.name);

            // Create new material with atlas
            var atlasMaterial = new Material(materials[0].shader);
            CopyMaterialProperties(materials[0], atlasMaterial);
            atlasMaterial.mainTexture = atlas;
            atlasMaterial.name = $"AtlasMaterial_{signature.GetHashCode()}";

            // Save material asset
            SaveAtlasMaterial(atlasMaterial, settings.outputPath);

            // Map original materials to UV rects
            uvRects = new Dictionary<Material, Rect>();

            for (int i = 0; i < materials.Count; i++) { uvRects[materials[i]] = rects[i]; }

            return atlasMaterial;
        }

        private static TextureAtlasData ExtractTextureData(List<Material> materials)
        {
            var data = new TextureAtlasData();

            foreach (var material in materials)
            {
                var mainTex = material.mainTexture as Texture2D;

                if (mainTex != null)
                {
                    // Make texture readable if it isn't
                    var readableTexture = MakeTextureReadable(mainTex);
                    data.textures.Add(readableTexture);
                    data.originalMaterials.Add(material);
                }
            }

            return data;
        }

        private static Texture2D MakeTextureReadable(Texture2D original)
        {
            if (original.isReadable) return original;

            // Create a temporary RenderTexture
            var renderTex = RenderTexture.GetTemporary(original.width, original.height, 0, RenderTextureFormat.Default, RenderTextureReadWrite.Linear);
            Graphics.Blit(original, renderTex);

            var previous = RenderTexture.active;
            RenderTexture.active = renderTex;

            var readableTexture = new Texture2D(original.width, original.height);
            readableTexture.ReadPixels(new Rect(0, 0, renderTex.width, renderTex.height), 0, 0);
            readableTexture.Apply();

            RenderTexture.active = previous;
            RenderTexture.ReleaseTemporary(renderTex);

            return readableTexture;
        }

        private static void CombineMeshesWithUVRemapping(List<MeshData> meshes, Material atlasMaterial,
            Dictionary<Material, Rect> uvRects, GameObject parent)
        {
            var combines = new List<CombineInstance>();

            foreach (var meshData in meshes)
            {
                var mesh = meshData.mesh;
                var uvRect = uvRects[meshData.material];

                // Create a copy of the mesh with remapped UVs
                var remappedMesh = RemapMeshUVs(mesh, meshData.submeshIndex, uvRect);

                var combine = new CombineInstance
                {
                    mesh = remappedMesh,
                    subMeshIndex = 0, // All submeshes become one after UV remapping
                    transform = meshData.transform.localToWorldMatrix
                };

                combines.Add(combine);
            }

            if (combines.Count > 0)
            {
                var combinedMesh = new Mesh();
                combinedMesh.name = $"CombinedAtlas_{atlasMaterial.name}";
                combinedMesh.indexFormat = UnityEngine.Rendering.IndexFormat.UInt32; // Support large meshes
                combinedMesh.CombineMeshes(combines.ToArray(), true, true);

                // Optimize the mesh
                combinedMesh.Optimize();
                combinedMesh.RecalculateNormals();
                combinedMesh.RecalculateBounds();

                // Create GameObject
                var combinedObj = new GameObject($"Combined_{atlasMaterial.name}");
                combinedObj.transform.parent = parent.transform;

                var renderer = combinedObj.AddComponent<MeshRenderer>();
                var filter = combinedObj.AddComponent<MeshFilter>();

                renderer.material = atlasMaterial;
                filter.mesh = combinedMesh;

                Debug.Log($"Combined {combines.Count} meshes into single draw call with atlas");
            }
        }

        private static Mesh RemapMeshUVs(Mesh originalMesh, int submeshIndex, Rect uvRect)
        {
            var mesh = Object.Instantiate(originalMesh);
            var vertices = mesh.vertices;
            var uvs = mesh.uv;
            var triangles = mesh.GetTriangles(submeshIndex);

            // Remap UVs to atlas coordinates
            for (int i = 0; i < uvs.Length; i++)
            {
                uvs[i] = new Vector2(
                    uvRect.x + uvs[i].x * uvRect.width,
                    uvRect.y + uvs[i].y * uvRect.height
                );
            }

            // Create new mesh with only the specified submesh
            var newMesh = new Mesh();
            newMesh.vertices = vertices;
            newMesh.uv = uvs;
            newMesh.triangles = triangles;
            newMesh.normals = mesh.normals;
            newMesh.tangents = mesh.tangents;

            if (mesh.colors.Length > 0) newMesh.colors = mesh.colors;
            if (mesh.uv2.Length > 0) newMesh.uv2 = mesh.uv2;

            return newMesh;
        }

        private static void CopyMaterialProperties(Material source, Material target)
        {
            // Copy common properties (extend as needed)
            if (source.HasProperty("_Color")) target.color = source.color;
            if (source.HasProperty("_Metallic")) target.SetFloat("_Metallic", source.GetFloat("_Metallic"));
            if (source.HasProperty("_Glossiness")) target.SetFloat("_Glossiness", source.GetFloat("_Glossiness"));
            if (source.HasProperty("_BumpScale")) target.SetFloat("_BumpScale", source.GetFloat("_BumpScale"));

            // Copy render queue and keywords
            target.renderQueue = source.renderQueue;
            target.shaderKeywords = source.shaderKeywords;
        }

        private static void SaveAtlasTexture(Texture2D atlas, string path, string name)
        {
            Directory.CreateDirectory(path);
            var bytes = atlas.EncodeToPNG();
            File.WriteAllBytes(Path.Combine(path, $"{name}.png"), bytes);

            AssetDatabase.ImportAsset(Path.Combine(path, $"{name}.png"));
        }

        private static void SaveAtlasMaterial(Material material, string path)
        {
            Directory.CreateDirectory(path);
            AssetDatabase.CreateAsset(material, Path.Combine(path, $"{material.name}.mat"));
        }

        private static bool IsAnimated(GameObject obj)
        {
            return obj.GetComponent<Animator>() != null ||
                   obj.GetComponent<Animation>() != null ||
                   obj.GetComponentInParent<Animator>() != null ||
                   obj.GetComponentInParent<Animation>() != null;
        }
    }

    // Helper classes
    public struct MeshData
    {
        public Mesh mesh;
        public Transform transform;
        public MeshRenderer renderer;
        public Material material;
        public int submeshIndex;
    }

    public class MaterialSignature
    {
        public Shader shader;
        public Dictionary<string, object> properties;

        public MaterialSignature(Material material)
        {
            shader = material.shader;
            properties = new Dictionary<string, object>();

            // Extract non-texture properties for comparison
            for (int i = 0; i < material.shader.GetPropertyCount(); i++)
            {
                var propName = material.shader.GetPropertyName(i);
                var propType = material.shader.GetPropertyType(i);

                switch (propType)
                {
                    case UnityEngine.Rendering.ShaderPropertyType.Color:
                        if (material.HasProperty(propName))
                            properties[propName] = material.GetColor(propName);

                        break;
                    case UnityEngine.Rendering.ShaderPropertyType.Vector:
                        if (material.HasProperty(propName))
                            properties[propName] = material.GetVector(propName);

                        break;
                    case UnityEngine.Rendering.ShaderPropertyType.Float:
                    case UnityEngine.Rendering.ShaderPropertyType.Range:
                        if (material.HasProperty(propName))
                            properties[propName] = material.GetFloat(propName);

                        break;
                    case UnityEngine.Rendering.ShaderPropertyType.Int:
                        if (material.HasProperty(propName))
                            properties[propName] = material.GetInt(propName);

                        break;

                    // Skip textures - we want to group materials that differ only by texture
                }
            }
        }

        public override bool Equals(object obj)
        {
            if (!(obj is MaterialSignature other)) return false;

            if (shader != other.shader) return false;
            if (properties.Count != other.properties.Count) return false;

            foreach (var kvp in properties)
            {
                if (!other.properties.ContainsKey(kvp.Key)) return false;
                if (!kvp.Value.Equals(other.properties[kvp.Key])) return false;
            }

            return true;
        }

        public override int GetHashCode()
        {
            var hash = shader.GetHashCode();

            foreach (var kvp in properties) { hash ^= kvp.Key.GetHashCode() ^ kvp.Value.GetHashCode(); }

            return hash;
        }
    }

    public class TextureAtlasData
    {
        public List<Texture2D> textures = new List<Texture2D>();
        public List<Material> originalMaterials = new List<Material>();
    }
}

// Editor integration
// public class MeshCombinerEditor : EditorWindow
// {
//     private AdvancedMeshCombiner.AtlasSettings settings = new AdvancedMeshCombiner.AtlasSettings();
//     private GameObject[] selectedObjects;
//
//     [MenuItem("Tools/Advanced Mesh Combiner")]
//     public static void ShowWindow()
//     {
//         GetWindow<MeshCombinerEditor>("Mesh Combiner");
//     }
//
//     private void OnGUI()
//     {
//         GUILayout.Label("Advanced Mesh Combiner with UV Atlasing", EditorStyles.boldLabel);
//
//         EditorGUILayout.Space();
//
//         // Atlas settings
//         GUILayout.Label("Atlas Settings", EditorStyles.boldLabel);
//         settings.atlasSize = EditorGUILayout.IntSlider("Atlas Size", settings.atlasSize, 512, 4096);
//         settings.padding = EditorGUILayout.IntSlider("Padding", settings.padding, 0, 10);
//         settings.filterMode = (FilterMode)EditorGUILayout.EnumPopup("Filter Mode", settings.filterMode);
//         settings.format = (TextureFormat)EditorGUILayout.EnumPopup("Texture Format", settings.format);
//         settings.generateMipmaps = EditorGUILayout.Toggle("Generate Mipmaps", settings.generateMipmaps);
//         settings.outputPath = EditorGUILayout.TextField("Output Path", settings.outputPath);
//
//         EditorGUILayout.Space();
//
//         if (GUILayout.Button("Combine Selected Objects"))
//         {
//             selectedObjects = Selection.gameObjects;
//             if (selectedObjects.Length > 0)
//             {
//                 var result = AdvancedMeshCombiner.CombineWithAtlasing(selectedObjects, settings);
//                 Selection.activeGameObject = result;
//                 Debug.Log($"Combined {selectedObjects.Length} objects with atlasing");
//             }
//             else
//             {
//                 Debug.LogWarning("No objects selected!");
//             }
//         }
//
//         if (GUILayout.Button("Process Asset Bundle Folder"))
//         {
//             ProcessAssetBundleFolder();
//         }
//     }
//
//     private void ProcessAssetBundleFolder()
//     {
//         string folderPath = EditorUtility.OpenFolderPanel("Select Asset Bundle Folder", "Assets", "");
//         if (!string.IsNullOrEmpty(folderPath))
//         {
//             // Convert absolute path to relative
//             folderPath = "Assets" + folderPath.Substring(Application.dataPath.Length);
//
//             string[] guids = AssetDatabase.FindAssets("t:GameObject", new[] { folderPath });
//
//             foreach (string guid in guids)
//             {
//                 string path = AssetDatabase.GUIDToAssetPath(guid);
//                 GameObject prefab = AssetDatabase.LoadAssetAtPath<GameObject>(path);
//
//                 if (prefab != null)
//                 {
//                     var meshRenderers = prefab.GetComponentsInChildren<MeshRenderer>();
//                     if (meshRenderers.Length > 1)
//                     {
//                         var combined = AdvancedMeshCombiner.CombineWithAtlasing(
//                             meshRenderers.Select(mr => mr.gameObject).ToArray(),
//                             settings
//                         );
//
//                         // Save as new prefab
//                         string newPath = path.Replace(".prefab", "_Combined.prefab");
//                         PrefabUtility.SaveAsPrefabAsset(combined, newPath);
//                         DestroyImmediate(combined);
//
//                         Debug.Log($"Processed: {path} -> {newPath}");
//                     }
//                 }
//             }
//
//             AssetDatabase.SaveAssets();
//             AssetDatabase.Refresh();
//             Debug.Log("Asset bundle processing complete!");
//         }
//     }
// }
