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
        [SerializeField] private bool useCustomFileProvider = false;
        [SerializeField] public bool useOriginalMaterials;
        [HideInInspector] [SerializeField] private ContentMap[] contentMaps;
        [SerializeField] private string fileRootPath;
        [SerializeField] private string hash;

        private Dictionary<string, string> contentTable;
        private HashSet<string> assetNames = new ();
        private List<string> textureNames;
        private HashSet<Texture2D> textureHash;
        private Dictionary<Texture2D, List<TexMaterialMap>> texMaterialMap;
        private HashSet<Texture2D> baseColor;
        private HashSet<Texture2D> normals;
        private HashSet<Texture2D> metallics;
        private IEditorDownloadProvider downloadProvider;

        public void SetupCustomFileProvider(ContentMap[] contentMap, string fileRootPath, string hash)
        {
            this.hash = hash;
            this.fileRootPath = fileRootPath;
            contentMaps = contentMap;
            useCustomFileProvider = true;
        }

        public override void OnImportAsset(AssetImportContext ctx)
        {
            if (useCustomFileProvider)
            {
                contentTable = new Dictionary<string, string>();

                if (contentMaps == null || contentMaps.Length == 0) return;

                foreach (ContentMap contentMap in contentMaps)
                    contentTable.Add(contentMap.file, contentMap.path);

                SetupCustomGltfDownloadProvider(new GltFastFileProvider(fileRootPath, hash, contentTable));
            }
            else
            {
                Debug.LogWarning($"Importing without file provider, there can be errors because of relative path files, please run the pipeline again");
                return;
            }

            if (!useOriginalMaterials)
                SetupCustomMaterialGenerator(new AssetBundleConverterMaterialGenerator());

            try { base.OnImportAsset(ctx); }
            catch (Exception e)
            {
                Debug.LogError("UNCAUGHT FATAL: Failed to Import GLTF " + hash);
                Debug.LogException(e);
                Utils.Exit((int)DCL.ABConverter.AssetBundleConverter.ErrorCodes.GLTFAST_CRITICAL_ERROR);
            }
        }

        protected override void PreProcessGameObjects(GameObject sceneGo)
        {
            var meshFilters = sceneGo.GetComponentsInChildren<MeshFilter>();

            foreach (MeshFilter filter in meshFilters)
            {
                if (filter.name.Contains("_collider", StringComparison.InvariantCultureIgnoreCase))
                    ConfigureColliders(filter);
            }
        }

        private static void ConfigureColliders(MeshFilter filter)
        {
            Physics.BakeMesh(filter.sharedMesh.GetInstanceID(), false);
            filter.gameObject.AddComponent<MeshCollider>();
            DestroyImmediate(filter.GetComponent<MeshRenderer>());

            foreach (Transform child in filter.transform)
            {
                var f = child.gameObject.GetComponent<MeshFilter>();
                ConfigureColliders(f);
            }
        }

        protected override void CreateMaterialAssets(AssetImportContext ctx)
        {
            var ctxMainObject = (GameObject)ctx.mainObject;
            if (ctxMainObject == null) return;

            textureNames = new List<string>();
            textureHash = new HashSet<Texture2D>();
            texMaterialMap = new Dictionary<Texture2D, List<TexMaterialMap>>();
            baseColor = new HashSet<Texture2D>();
            normals = new HashSet<Texture2D>();
            metallics = new HashSet<Texture2D>();

            var folderName = Path.GetDirectoryName(ctx.assetPath);
            var renderers = ctxMainObject.GetComponentsInChildren<Renderer>(true);

            List<Material> materials = ReplaceMaterials(folderName, renderers);

            var textures = materials.SelectMany(GetTexturesFromMaterial).ToList();

            FixTextureReferences(textures, folderName, materials);
        }

        private List<Material> ReplaceMaterials(string folderName, Renderer[] renderers)
        {
            List<Material> materials = new ();

            for (var i = 0; i < m_Gltf.MaterialCount; i++)
            {
                var invalidMaterial = m_Gltf.GetMaterial(i);

                if (invalidMaterial == null)
                    continue;

                string invalidMaterialName = invalidMaterial.name;
                Material validMaterial = GetExtractedMaterial(folderName, invalidMaterialName);

                materials.Add(validMaterial);
                ReplaceReferences(renderers, validMaterial);
            }

            if (m_Gltf.defaultMaterial != null)
            {
                Material validDefaultMaterial = GetExtractedMaterial(folderName, m_Gltf.defaultMaterial.name);
                materials.Add(validDefaultMaterial);
                ReplaceReferences(renderers, validDefaultMaterial);
                foreach (Renderer renderer in renderers)
                {
                    var sharedMaterials = renderer.sharedMaterials;
                    for (var i = 0; i < sharedMaterials.Length; i++)
                        if (sharedMaterials[i] == null)
                            sharedMaterials[i] = validDefaultMaterial;

                    renderer.sharedMaterials = sharedMaterials;
                }
            }

            return materials;
        }

        private Material GetExtractedMaterial(string folderName, string materialName)
        {
            materialName = Utils.NicifyName(materialName);
            var path = $"{folderName}{Path.DirectorySeparatorChar}Materials{Path.DirectorySeparatorChar}{materialName}.mat";
            var validMaterial = AssetDatabase.LoadAssetAtPath<Material>(path);

            if (validMaterial == null)
                throw new Exception(path + " does not exist");

            return validMaterial;
        }

        private static Dictionary<string, TexMaterialMap> GetMatMapsFromMaterial(Material rendererSharedMaterial)
        {
            var maps = new Dictionary<string, TexMaterialMap>();
            var shader = rendererSharedMaterial.shader;

            for (var i = 0; i < ShaderUtil.GetPropertyCount(shader); ++i)
            {
                if (ShaderUtil.GetPropertyType(shader, i) == ShaderUtil.ShaderPropertyType.TexEnv)
                {
                    var propertyName = ShaderUtil.GetPropertyName(shader, i);
                    var tex = rendererSharedMaterial.GetTexture(propertyName) as Texture2D;

                    if (!tex)
                        continue;

                    maps[$"{rendererSharedMaterial.name}_{propertyName}"] = new TexMaterialMap(rendererSharedMaterial, propertyName, false);
                }
            }

            return maps;
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
                        texPath = $"{folderName}{separator}Textures{separator}{tex.name}";

                        texPath = texPath.Replace(separator, '/');

                        //remove all whitespaces
                        texPath = Regex.Replace(texPath, @"\s+", "");

                        if (!Path.HasExtension(texPath))
                            texPath += ".png";
                    }

                    //var importedTex = AssetDatabase.LoadAssetAtPath<Texture2D>(texPath);
                    var importer = GetAtPath(texPath);

                    if (importer is TextureImporter tImporter)
                    {
                        tImporter.isReadable = false;

                        // texture is considered normal only if all material maps are true
                        var isNormalMap = true;

                        foreach (TexMaterialMap materialMap in materialMaps)
                            isNormalMap &= materialMap.IsNormalMap;

                        TextureImporterType targetImportType = GetTextureImporterType(tImporter, isNormalMap);
                        tImporter.textureType = targetImportType;

                        tImporter.crunchedCompression = true;
                        tImporter.sRGBTexture = !metallics.Contains(tex);
                        tImporter.compressionQuality = 100;
                        tImporter.textureCompression = TextureImporterCompression.CompressedHQ;
                        tImporter.mipmapEnabled = false;

                        // With this we avoid re-importing this glb as it may contain invalid references to textures
                        EditorUtility.SetDirty(tImporter);
                        tImporter.SaveAndReimport();
                    }
                    else { throw new Exception($"GLTFImporter: Unable to import texture at path: {texPath}"); }
                }
            }
        }

        private static TextureImporterType GetTextureImporterType(TextureImporter tImporter, bool isNormalMap)
        {
            var targetImportType = tImporter.textureType;

            if (isNormalMap)
                targetImportType = TextureImporterType.NormalMap;
            else if (tImporter.textureType == TextureImporterType.Sprite)
                targetImportType = TextureImporterType.Default;

            return targetImportType;
        }

        /*private void FixMaterialReferences(List<Material> materials, string folderName, Renderer[] renderers)
        {
            if (materials.Count > 0)
            {
                var materialRoot = string.Concat(folderName, "/", "Materials/");
                Directory.CreateDirectory(materialRoot);

                for (var i = 0; i < materials.Count; i++)
                {
                    var mat = materials[i];
                    var materialPath = string.Concat(materialRoot, mat.name, ".mat");

                    CopyOrNew(mat, materialPath, m => { ReplaceReferences(renderers, m); });
                }
            }
        }*/

        private static void ReplaceReferences(Renderer[] renderers, Material mat)
        {
            if (mat == null)
            {
                Debug.LogError("FATAL!");
                return;
            }

            foreach (var r in renderers)
            {
                var sharedMaterials = r.sharedMaterials;

                for (var i = 0; i < sharedMaterials.Length; ++i)
                {
                    var sharedMaterial = sharedMaterials[i];

                    string sharedMaterialName = sharedMaterial ? sharedMaterial.name : "";
                    sharedMaterialName = Utils.NicifyName(sharedMaterialName);

                    if (sharedMaterialName != mat.name) continue;

                    sharedMaterials[i] = mat;
                    EditorUtility.SetDirty(mat);
                }

                sharedMaterials = sharedMaterials.Where(sm => sm).ToArray();
                r.sharedMaterials = sharedMaterials;
                EditorUtility.SetDirty(r);
            }
        }

        private void FixMaterialNames(List<Material> materials)
        {
            foreach (var mat in materials)
            {
                if (mat != null)
                {
                    var matName = string.IsNullOrEmpty(mat.name) ? mat.shader.name : mat.name;

                    if (matName == mat.shader.name) { matName = matName.Substring(Mathf.Min(matName.LastIndexOf("/") + 1, matName.Length - 1)); }

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

            if (!shader) { return Enumerable.Empty<Texture2D>(); }

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
                            if (propertyName.StartsWith("_")) { texName = propertyName.Substring(Mathf.Min(1, propertyName.Length - 1)); }
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

                    bool isNormalMap = IsNormalMap(propertyName);
                    materialMaps.Add(new TexMaterialMap(mat, propertyName, isNormalMap));

                    bool isBaseTexture = IsBaseTexture(propertyName);

                    if (isBaseTexture) { baseColor.Add(tex); }

                    if (isNormalMap) { normals.Add(tex); }
                    else if (IsMetallicMap(propertyName)) { metallics.Add(tex); }
                }
            }

            return matTextures;
        }

        private static bool IsMetallicMap(string propertyName) =>
            propertyName is "_MetallicGlossMap" or "metallicRoughnessTexture";

        private static bool IsBaseTexture(string propertyName) =>
            propertyName is "_BaseMap" or "baseColorTexture";

        private static bool IsNormalMap(string propertyName) =>
            propertyName is "_BumpMap" or "normalTexture";

        protected override void CreateTextureAssets(AssetImportContext ctx)
        {
            // intended nothingness
        }

        private string PatchInvalidFileNameChars(string fileName)
        {
            foreach (char c in Path.GetInvalidFileNameChars()) { fileName = fileName.Replace(c, '_'); }

            fileName = fileName.Replace(":", "_");
            fileName = fileName.Replace("|", "_");

            return fileName;
        }

        private void CopyOrNew<T>(T asset, string assetPath, Action<T> replaceReferences) where T: Object
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

            for (int i = 0; i < m_Gltf.MaterialCount; i++) { materials.Add(m_Gltf.GetMaterial(i)); }

            return materials;
        }
    }
}
