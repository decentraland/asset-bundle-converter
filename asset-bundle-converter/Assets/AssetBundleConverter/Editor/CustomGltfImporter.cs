using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using AssetBundleConverter.Wrappers.Implementations.Default;
using DCL.ABConverter;
using GLTFast.Editor;
using System.Text.RegularExpressions;
using UnityEditor;
using UnityEditor.AssetImporters;
using UnityEngine;
using Object = UnityEngine.Object;

namespace AssetBundleConverter.Editor
{
    [Serializable]
    public struct ContentMap
    {
        public string file;
        public string path;

        public ContentMap(string file, string path)
        {
            this.file = file;
            this.path = path;
        }
    }

    [ScriptedImporter(1, new[] { "gltf", "glb" })]
    public class CustomGltfImporter : GltfImporter
    {
        [SerializeField] public ContentMap[] contentMaps;
        private Dictionary<string,string> contentTable;

        private HashSet<string> assetNames = new HashSet<string>();
        private List<string> textureNames;
        private HashSet<Texture2D> textureHash;
        private Dictionary<Texture2D, List<TexMaterialMap>> texMaterialMap;
        private HashSet<Texture2D> baseColor;
        private HashSet<Texture2D> normals;
        private HashSet<Texture2D> metallics;

        protected override void CreateMaterialAssets(AssetImportContext ctx)
        {
            var folderName = Path.GetDirectoryName(ctx.assetPath);
            var renderers = ((GameObject)ctx.mainObject).GetComponentsInChildren<Renderer>(true);
            var materials = SimplifyMaterials(renderers);

            textureNames = new List<string>();
            textureHash = new HashSet<Texture2D>();
            texMaterialMap = new Dictionary<Texture2D, List<TexMaterialMap>>();
            baseColor = new HashSet<Texture2D>();
            normals = new HashSet<Texture2D>();
            metallics = new HashSet<Texture2D>();
            var textures = materials.SelectMany(GetTexturesFromMaterial).ToList();

            FixTextureReferences(textures, folderName, materials);
            CreateMaterialAssets(materials, folderName, renderers);
        }

        private void FixTextureReferences(List<Texture2D> textures, string folderName, List<Material> materials)
        {
            var separator = Path.DirectorySeparatorChar;
            if (textures.Count > 0)
            {
                for (var i = 0; i < textures.Count; ++i)
                {
                    var tex = textures[i];
                    var materialMaps = texMaterialMap[tex];
                    string texPath = AssetDatabase.GetAssetPath(tex);

                    if (string.IsNullOrEmpty(texPath))
                    {
                        texPath = $"{folderName}{separator}Textures{separator}{tex.name}.png";
                    }

                    texPath = texPath.Replace(separator, '/');

                    texPath = Regex.Replace(texPath, @"\s+", "");
                    var importedTex = AssetDatabase.LoadAssetAtPath<Texture2D>(texPath);
                    var importer = GetAtPath(texPath);

                    if (importer is TextureImporter tImporter)
                    {
                        tImporter.isReadable = false;
                        var isNormalMap = true;

                        foreach (var material in materials)
                        {
                            foreach (var materialMap in materialMaps)
                            {
                                if (materialMap.Material == material)
                                {
                                    //NOTE(Brian): Only set as normal map if is exclusively
                                    //             used for that.
                                    //             We don't want DXTnm in color textures.
                                    if (!materialMap.IsNormalMap)
                                        isNormalMap = false;

                                    material.SetTexture(materialMap.Property, importedTex);
                                    EditorUtility.SetDirty(material);
                                }
                            }
                        }

                        if (isNormalMap)
                        {
                            // Try to auto-detect normal maps
                            tImporter.textureType = TextureImporterType.NormalMap;
                        }
                        else if (tImporter.textureType == TextureImporterType.Sprite)
                        {
                            // Force disable sprite mode, even for 2D projects
                            tImporter.textureType = TextureImporterType.Default;
                        }

                        tImporter.crunchedCompression = true;
                        tImporter.sRGBTexture = !metallics.Contains(tex);
                        tImporter.compressionQuality = 100;
                        tImporter.textureCompression = TextureImporterCompression.CompressedHQ;

                        // With this we avoid re-importing this glb as it may contain invalid references to textures
                        EditorUtility.SetDirty(tImporter);
                        tImporter.SaveAndReimport();
                    }
                    else
                    {
                        Debug.LogWarning($"GLTFImporter: Unable to import texture at path: {texPath}");
                    }
                }
            }
        }

        private void CreateMaterialAssets(List<Material> materials, string folderName, Renderer[] renderers)
        {
            if (materials.Count > 0)
            {
                var materialRoot = string.Concat(folderName, "/", "Materials/");
                Directory.CreateDirectory(materialRoot);

                for (var i = 0; i < materials.Count; i++)
                {
                    var mat = materials[i];
                    var materialPath = string.Concat(materialRoot, mat.name, ".mat");

                    CopyOrNew(mat, materialPath, m =>
                    {
                        foreach (var r in renderers)
                        {
                            var sharedMaterials = r.sharedMaterials;

                            for (var i = 0; i < sharedMaterials.Length; ++i)
                            {
                                var sharedMaterial = sharedMaterials[i];

                                if (sharedMaterial.name == mat.name)
                                {
                                    sharedMaterials[i] = m;
                                    EditorUtility.SetDirty(m);
                                }
                            }

                            sharedMaterials = sharedMaterials.Where(sm => sm).ToArray();
                            r.sharedMaterials = sharedMaterials;
                        }
                    });
                }
            }
        }

        private void FixMaterialNames(List<Material> materials)
        {
            foreach (var mat in materials)
            {
                if (mat != null)
                {
                    var matName = string.IsNullOrEmpty(mat.name) ? mat.shader.name : mat.name;

                    if (matName == mat.shader.name)
                    {
                        matName = matName.Substring(Mathf.Min(matName.LastIndexOf("/") + 1, matName.Length - 1));
                    }

                    matName = PatchInvalidFileNameChars(matName);
                    matName = ObjectNames.NicifyVariableName(matName);
                    matName = ObjectNames.GetUniqueName(assetNames.ToArray(), matName);

                    mat.name = matName;
                    assetNames.Add(matName);
                }
            }
        }

        private IEnumerable<Texture2D> GetTexturesFromMaterial(Material mat)
        {
            var shader = mat.shader;

            if (!shader)
            {
                return Enumerable.Empty<Texture2D>();
            }

            var matTextures = new List<Texture2D>();

            for (var i = 0; i < ShaderUtil.GetPropertyCount(shader); ++i)
            {
                if (ShaderUtil.GetPropertyType(shader, i) == ShaderUtil.ShaderPropertyType.TexEnv)
                {
                    var propertyName = ShaderUtil.GetPropertyName(shader, i);
                    var tex = mat.GetTexture(propertyName) as Texture2D;

                    if (!tex)
                        continue;

                    if (textureHash.Add(tex))
                    {
                        var texName = tex.name;

                        if (string.IsNullOrEmpty(texName))
                        {
                            if (propertyName.StartsWith("_"))
                            {
                                texName = propertyName.Substring(Mathf.Min(1, propertyName.Length - 1));
                            }
                        }

                        // Ensure name is unique
                        texName = ObjectNames.NicifyVariableName(texName);
                        texName = ObjectNames.GetUniqueName(textureNames.ToArray(), texName);

                        tex.name = texName;
                        textureNames.Add(texName);
                        matTextures.Add(tex);
                    }

                    List<TexMaterialMap> materialMaps;

                    if (!texMaterialMap.TryGetValue(tex, out materialMaps))
                    {
                        materialMaps = new List<TexMaterialMap>();
                        texMaterialMap.Add(tex, materialMaps);
                    }

                    materialMaps.Add(new TexMaterialMap(mat, propertyName, propertyName == "_BumpMap"));

                    if (propertyName == "_BaseMap")
                    {
                        baseColor.Add(tex);
                    }

                    if (propertyName == "_BumpMap")
                    {
                        normals.Add(tex);
                    }
                    else if (propertyName == "_MetallicGlossMap")
                    {
                        metallics.Add(tex);
                    }
                }
            }

            return matTextures;
        }


        protected override void CreateTextureAssets(AssetImportContext ctx)
        {
            // intended nothingness
        }

        public override void OnImportAsset(AssetImportContext ctx)
        {
            contentTable = new Dictionary<string, string>();

            if (contentMaps == null || contentMaps.Length == 0) return;

            foreach (ContentMap contentMap in contentMaps)
            {
                contentTable.Add(contentMap.file, contentMap.path);
            }

            SetupExternalDependencies(GetDependenciesPaths);
            SetupCustomMaterialGenerator(new AssetBundleConverterMaterialGenerator());

            base.OnImportAsset(ctx);
        }

        private string PatchInvalidFileNameChars(string fileName)
        {
            foreach (char c in Path.GetInvalidFileNameChars())
            {
                fileName = fileName.Replace(c, '_');
            }

            fileName = fileName.Replace(":", "_");
            fileName = fileName.Replace("|", "_");

            return fileName;
        }

        private void CopyOrNew<T>(T asset, string assetPath, Action<T> replaceReferences) where T : Object
        {
            var existingAsset = AssetDatabase.LoadAssetAtPath<T>(assetPath);

            if (existingAsset)
            {
                EditorUtility.CopySerialized(asset, existingAsset);
                replaceReferences(existingAsset);

                return;
            }

            try
            {
                AssetDatabase.CreateAsset(asset, assetPath);
                existingAsset = AssetDatabase.LoadAssetAtPath<T>(assetPath);
                replaceReferences(existingAsset);
            }
            catch (Exception e)
            {
                Debug.LogWarning(assetPath);
                Debug.LogException(e);
            }
        }

        public List<Material> SimplifyMaterials(Renderer[] renderers)
        {
            var materials = new List<Material>();
            for (int i = 0; i < m_Gltf.materialCount; i++)
            {
                materials.Add(m_Gltf.GetMaterial(i));
            }
            return materials;
        }

        private class TexMaterialMap
        {
            public Material Material { get; set; }
            public string Property { get; set; }
            public bool IsNormalMap { get; set; }

            public TexMaterialMap(Material material, string property, bool isNormalMap)
            {
                Material = material;
                Property = property;
                IsNormalMap = isNormalMap;
            }
        }

        private Uri GetDependenciesPaths(Uri url)
        {
            try
            {
                var normalizedString = url.OriginalString.Replace('\\', '/');
                string fileName = normalizedString.Substring(normalizedString.LastIndexOf('/') + 1);

                return !contentTable.ContainsKey(fileName) ? url : new Uri(contentTable[fileName], UriKind.Relative);
            }
            catch (Exception)
            {
                Debug.LogError($"Failed to transform path: {url.OriginalString}");
                return url;
            }
        }
    }
}
