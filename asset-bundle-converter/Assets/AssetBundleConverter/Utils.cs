using AssetBundleConverter;
using Newtonsoft.Json;
using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Net.Http;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading.Tasks;
using UnityEditor;
using UnityEngine;
using UnityEngine.Networking;
using UnityEngine.Rendering;
using static DCL.ContentServerUtils;
using Environment = System.Environment;
using Object = UnityEngine.Object;

namespace DCL.ABConverter
{
    public static class MeshUtils
    {
        public static Bounds BuildMergedBounds(Renderer[] renderers)
        {
            Bounds bounds = new Bounds();

            for (int i = 0; i < renderers.Length; i++)
            {
                if (renderers[i] == null)
                    continue;

                if (i == 0)
                    bounds = renderers[i].GetSafeBounds();
                else
                    bounds.Encapsulate(renderers[i].GetSafeBounds());
            }

            return bounds;
        }

        /// <summary>
        /// This get the renderer bounds with a check to ensure the renderer is at a safe position.
        /// If the renderer is too far away from 0,0,0, wasm target ensures a crash.
        /// </summary>
        /// <param name="renderer"></param>
        /// <returns>The bounds value if the value is correct, or a mocked bounds object with clamped values if its too far away.</returns>
        public static Bounds GetSafeBounds(this Renderer renderer)
        {
            // World extents are of 4800 world mts, so this limit far exceeds the world size.
            const float POSITION_OVERFLOW_LIMIT = 10000;
            const float POSITION_OVERFLOW_LIMIT_SQR = POSITION_OVERFLOW_LIMIT * POSITION_OVERFLOW_LIMIT;

            if (renderer.transform.position.sqrMagnitude > POSITION_OVERFLOW_LIMIT_SQR)
                return new Bounds(Vector3.one * POSITION_OVERFLOW_LIMIT, Vector3.one * 0.1f);

            return renderer.bounds;
        }
    }

    public static class PlatformUtils
    {

        public static BuildTarget currentTarget;

        public static string GetPlatform()
        {
            if (currentTarget == BuildTarget.StandaloneWindows64)
                return "_windows";
            if (currentTarget == BuildTarget.StandaloneOSX)
                return "_mac";
            if (Application.platform == RuntimePlatform.LinuxPlayer)
                return "_linux";

            return ""; //Means we are in WebGL, no extra parameters needed
        }

        //This method removes the platform from the path, since they are absolute in the downloaded project
        public static string RemovePlatform(string pathToRemovePlatform)
        {
            string currentPlatform = GetPlatform();

            if (string.IsNullOrEmpty(currentPlatform))
                return pathToRemovePlatform;

            string updatedPath = pathToRemovePlatform.Replace(currentPlatform, "");
            return updatedPath;
        }
    }

    public static class PathUtils
    {
        /// <summary>
        /// Gets the relative path ("..\..\to_file_or_dir") of another file or directory (to) in relation to the current file/dir (from)
        /// </summary>
        /// <param name="to"></param>
        /// <param name="from"></param>
        /// <returns></returns>
        public static string GetRelativePathTo(string from, string to)
        {
            var fromPath = Path.GetFullPath(from);
            var toPath = Path.GetFullPath(to);

            var fromUri = new Uri(fromPath);
            var toUri = new Uri(toPath);

            var relativeUri = fromUri.MakeRelativeUri(toUri);
            var relativePath = Uri.UnescapeDataString(relativeUri.ToString());

            string result = FixDirectorySeparator(relativePath);

            return result;
        }

        /// <summary>
        /// Converts an absolute path to an Application.dataPath relative path.
        /// </summary>
        /// <param name="fullPath">the full path.</param>
        /// <returns>the Application.dataPath relative path</returns>
        public static string FullPathToAssetPath(string fullPath)
        {
            char ps = Path.DirectorySeparatorChar;

            fullPath = fullPath.Replace('/', ps);
            fullPath = fullPath.Replace('\\', ps);

            string pattern = $".*?\\{ps}(?<assetpath>Assets\\{ps}.*?$)";

            var regex = new Regex(pattern);

            var match = regex.Match(fullPath);

            if (match.Success && match.Groups["assetpath"] != null)
                return match.Groups["assetpath"].Value;

            return fullPath;
        }

        public static string FixDirectorySeparator(string path)
        {
            char ps = Path.DirectorySeparatorChar;
            path = path.Replace('/', ps);
            path = path.Replace('\\', ps);
            return path;
        }

        /// <summary>
        /// Convert a path relative to Application.dataPath to an absolute path.
        /// </summary>
        /// <param name="assetPath">The relative path</param>
        /// <param name="overrideDataPath">Convert from an arbitrary path instead of Application.dataPath. Used for testing.</param>
        /// <returns>The full path.</returns>
        public static string AssetPathToFullPath(string assetPath, string overrideDataPath = null)
        {
            assetPath = FixDirectorySeparator(assetPath);

            string dataPath = overrideDataPath ?? Application.dataPath;
            dataPath = FixDirectorySeparator(dataPath);

            char ps = Path.DirectorySeparatorChar;
            string dataPathWithoutAssets = dataPath.Replace($"{ps}Assets", "");
            return dataPathWithoutAssets + "/" + assetPath;
        }

        public static long GetFreeSpace()
        {
            DriveInfo info = new DriveInfo(new DirectoryInfo(Application.dataPath).Root.FullName);
            return info.AvailableFreeSpace;
        }
    }

    public static class TextureUtils
    {
        public static bool IsCompressedFormat(TextureFormat format)
        {
            switch (format)
            {
                case TextureFormat.DXT1:
                case TextureFormat.DXT5:
                case TextureFormat.BC7:
                case TextureFormat.ETC_RGB4:
                case TextureFormat.ETC2_RGB:
                case TextureFormat.ETC2_RGBA8:
                case TextureFormat.ASTC_4x4:
                case TextureFormat.ASTC_5x5:
                case TextureFormat.ASTC_6x6:
                case TextureFormat.ASTC_8x8:
                case TextureFormat.ASTC_10x10:
                case TextureFormat.ASTC_12x12:
                    return true;
                default:
                    return false;
            }
        }
    }

    public static class Utils
    {
        private const string LOG_FILENAME = "buildlogtep.json";

        public static void PrintDiskSize(string step)
        {
            var defaultDrive = DriveInfo.GetDrives()
                .FirstOrDefault();

            if (defaultDrive != null)
            {
                Debug.Log($"Size Step Drive Name: {defaultDrive.Name}");

                if (defaultDrive is { IsReady: true })
                {
                    long availableFreeSpace = defaultDrive.AvailableFreeSpace;
                    long totalFreeSpace = defaultDrive.TotalFreeSpace;
                    long totalSize = defaultDrive.TotalSize;

                    Debug.Log($"Size Step: {step}");
                    Debug.Log($"Size Step Available Free Space: {availableFreeSpace / (1024 * 1024)} MB");
                    Debug.Log($"Size Step Total Free Space: {totalFreeSpace / (1024 * 1024)} MB");
                    Debug.Log($"Size Step Total Size: {totalSize / (1024 * 1024)} MB");
                }
                else
                {
                    Debug.Log($"Size Step: Drive {defaultDrive.Name} is not ready.");
                }
            }
            else
            {
                Debug.Log("Size Step: No Drive available");
            }
        }


        [Serializable]
        private class PointersData
        {
            public string[] pointers;
        }

        internal static bool ParseOption(string[] fullCmdArgs, string optionName, int argsQty, out string[] foundArgs)
        {
            return ParseOptionExplicit(fullCmdArgs, optionName, argsQty, out foundArgs);
        }

        internal static bool ParseOption(string optionName, int argsQty, out string[] foundArgs)
        {
            return ParseOptionExplicit(Environment.GetCommandLineArgs(), optionName, argsQty, out foundArgs);
        }

        internal static bool ParseOptionExplicit(string[] rawArgsList, string optionName, int expectedArgsQty, out string[] foundArgs)
        {
            foundArgs = null;

            if (rawArgsList == null || rawArgsList.Length < expectedArgsQty + 1)
                return false;

            expectedArgsQty = Mathf.Min(expectedArgsQty, 100);

            var foundArgsList = new List<string>();
            int argState = 0;

            for (int i = 0; i < rawArgsList.Length; i++)
            {
                switch (argState)
                {
                    case 0:
                        if (rawArgsList[i] == "-" + optionName) { argState++; }

                        break;
                    default:
                        foundArgsList.Add(rawArgsList[i]);
                        argState++;
                        break;
                }

                if (argState > 0 && foundArgsList.Count == expectedArgsQty)
                    break;
            }

            if (argState == 0 || foundArgsList.Count < expectedArgsQty)
                return false;

            if (expectedArgsQty > 0)
                foundArgs = foundArgsList.ToArray();

            return true;
        }



        internal static void Exit(int errorCode = 0)
        {
            Debug.Log($"Process finished with code {errorCode}");

            if (Application.isBatchMode)
                EditorApplication.Exit(errorCode);
        }

        internal static void MarkFolderForAssetBundleBuild(string fullPath, string abName)
        {
            string assetPath = PathUtils.GetRelativePathTo(Application.dataPath, fullPath);
            assetPath = Path.GetDirectoryName(assetPath);
            AssetImporter importer = AssetImporter.GetAtPath(assetPath);
            importer.SetAssetBundleNameAndVariant(abName, "");
        }

        /// <param name="db"></param>
        /// <param name="shader"></param>
        /// <param name="buildVariantsCollection">Building variants collection is expensive and not required from CI</param>
        internal static void AssignShaderBundle(IAssetDatabase db, Shader shader, bool buildVariantsCollection)
        {
            var abName = shader.name + "_IGNORE" + PlatformUtils.GetPlatform();

            string assetPath = PathUtils.GetRelativePathTo(Application.dataPath, db.GetAssetPath(shader));

            var importer = AssetImporter.GetAtPath(assetPath);

            if (importer)
                importer.SetAssetBundleNameAndVariant(abName, "");

            // find a variants collection
            var variantsPath = assetPath.Replace(".shader", "Variants.shadervariants");

            importer = AssetImporter.GetAtPath(variantsPath);
            if (importer)
                importer.SetAssetBundleNameAndVariant(buildVariantsCollection ? abName : "", "");
        }

        internal static bool MarkAssetForAssetBundleBuild(IAssetDatabase assetDb, Object asset, string abName)
        {
            string assetPath = PathUtils.GetRelativePathTo(Application.dataPath, assetDb.GetAssetPath(asset));
            var importer = AssetImporter.GetAtPath(assetPath);

            if (importer)
            {
                importer.SetAssetBundleNameAndVariant(abName, "");
                return true;
            }

            return false;
        }

        public static MD5 md5 = new MD5CryptoServiceProvider();

        public static string CidToGuid(string cid)
        {
            byte[] data = md5.ComputeHash(Encoding.UTF8.GetBytes(cid));
            StringBuilder sBuilder = new StringBuilder();

            for (int i = 0; i < data.Length; i++) { sBuilder.Append(data[i].ToString("x2")); }

            return sBuilder.ToString();
        }

        public static async Task<EntityMappingsDTO[]> GetEntityMappings(Vector2Int entityPointer, ClientSettings settings,
            IWebRequest webRequest)
        {

            string url = "https://peer.decentraland.org/content/entities/active/";
            DownloadHandler downloadHandler = null;

            try
            {
                var pointersData = new PointersData { pointers = new[] { $"{entityPointer.x},{entityPointer.y}" } };
                var json = JsonUtility.ToJson(pointersData);
                downloadHandler = await webRequest.Post(url, json);
            }
            catch (HttpRequestException e)
            {
                Debug.LogException(new Exception($"Request error! mappings couldn't be fetched for scene {entityPointer}! -- {e.Message}"));
                Exit((int)ErrorCodes.UNEXPECTED_ERROR);
                return null;
            }

            List<EntityMappingsDTO> parcelInfoApiData = JsonConvert.DeserializeObject<List<EntityMappingsDTO>>(downloadHandler.text);
            downloadHandler.Dispose();

            if (parcelInfoApiData.Count == 0 || parcelInfoApiData == null) { throw new Exception("No mapping received"); }

            return parcelInfoApiData.ToArray();
        }

        public static async Task<MappingPair[]> GetEmptyScenesMappingAsync(string mappingName, ClientSettings settings, IWebRequest webRequest)
        {
            var url = $"{settings.baseUrl}{mappingName}";
            Debug.Log(url);

            DownloadHandler downloadHandler;

            try
            {
                downloadHandler = await webRequest.Get(url);
            }
            catch (HttpRequestException e)
            {
                var exception = new Exception($"Request error! Empty Scenes Mapping couldn't be fetched from {url}! -- {e.Message}");
                Debug.LogException(exception);
                Exit((int)ErrorCodes.UNEXPECTED_ERROR);
                return null;
            }

            Dictionary<string, MappingPair[]> mapping = JsonConvert.DeserializeObject<Dictionary<string, MappingPair[]>>(downloadHandler.text);
            downloadHandler.Dispose();

            return mapping.SelectMany(kvp => kvp.Value).ToArray();
        }

        public static async Task<EntityMappingsDTO[]> GetEntityMappingsAsync(string entityId, ClientSettings settings, IWebRequest webRequest)
        {
            var url = $"{settings.baseUrl}{entityId}";
            Debug.Log(url);
            DownloadHandler downloadHandler = null;

            try
            {
                downloadHandler = await webRequest.Get(url);
            }
            catch (HttpRequestException e)
            {
                var exception = new Exception($"Request error! mappings couldn't be fetched for scene {entityId}! -- {e.Message}");
                Debug.LogException(exception);
                Exit((int)ErrorCodes.UNEXPECTED_ERROR);
                return null;
            }

            if (downloadHandler.text.StartsWith("glTF"))
            {
                Debug.LogWarning("This url is a GLTF!");

                return new[]
                {
                    new EntityMappingsDTO
                    {
                        content = new[]
                        {
                            new MappingPair
                                { file = entityId + ".glb", hash = entityId }
                        }
                    }
                };
            }

            EntityMappingsDTO parcelInfoDto = JsonUtility.FromJson<EntityMappingsDTO>(downloadHandler.text);
            parcelInfoDto.id = entityId;
            downloadHandler.Dispose();

            if (parcelInfoDto == null) { throw new Exception("No mapping received"); }

            return new[] { parcelInfoDto };
        }


        /// <summary>
        /// Given a MappingPair list, returns a AssetPath list filtered by file extensions
        /// </summary>
        /// <param name="pairsToSearch">The MappingPair list to be filtered and converted</param>
        /// <param name="extensions">An array detailing the extensions to filter them</param>
        /// <returns>A dictionary that maps hashes to mapping pairs</returns>
        public static List<AssetPath> GetPathsFromPairs(string basePath, IReadOnlyList<MappingPair> pairsToSearch, string[] extensions)
        {
            var tmpResult = new Dictionary<(string, string), AssetPath>();

            for (int i = 0; i < pairsToSearch.Count; i++)
            {
                MappingPair mappingPair = pairsToSearch[i];

                bool hasExtension = extensions.Any(x => mappingPair.file.ToLower().EndsWith(x));

                if (hasExtension)
                {
                    if (!tmpResult.ContainsKey((mappingPair.hash, mappingPair.file)))
                        tmpResult.Add((mappingPair.hash, mappingPair.file), new AssetPath(basePath, mappingPair));
                }
            }

            return tmpResult.Values.ToList();
        }

        public static void CleanAssetBundleFolder(IFile file, string pathToSearch, string[] assetBundlesList, Dictionary<string, string> lowerToUpperDictionary)
        {
            //Deletes log file as it is unnecessary for the AB, can be done here only because it's auto generated by the scriptable build pipeline
            file.Delete(pathToSearch + LOG_FILENAME);

            for (int i = 0; i < assetBundlesList.Length; i++)
            {
                string assetBundleName = assetBundlesList[i];

                if (string.IsNullOrEmpty(assetBundleName))
                    continue;

                try
                {
                    var suffix = "";

                    if (assetBundleName.EndsWith("_windows"))
                    {
                        suffix = "_windows";
                        assetBundleName = assetBundleName.Replace("_windows", "");
                    } else if (assetBundleName.EndsWith("_osx"))
                    {
                        suffix = "_osx";
                        assetBundleName = assetBundleName.Replace("_osx", "");
                    }
                    //NOTE(Brian): This is done for correctness sake, rename files to preserve the hash upper-case
                    if (lowerToUpperDictionary.TryGetValue(assetBundleName, out string hashWithUppercase))
                    {
                        string oldPath = pathToSearch + assetBundlesList[i];
                        string path = pathToSearch + hashWithUppercase + suffix;
                        file.Move(oldPath, path);
                    }

                    string oldPathMf = pathToSearch + assetBundlesList[i] + ".manifest";
                    file.Delete(oldPathMf);
                }
                catch (Exception e) { Debug.LogWarning("Error! " + e.Message); }
            }
        }

        public static Texture2D ResizeTexture(Texture2D source, int newWidth, int newHeight, bool linear = false, bool useGPUCopy = true)
        {
            newWidth = Mathf.Max(1, newWidth);
            newHeight = Mathf.Max(1, newHeight);

            // RenderTexture default format is ARGB32
            Texture2D nTex = new Texture2D(newWidth, newHeight, TextureFormat.ARGB32, 1, linear);
            nTex.filterMode = source.filterMode;
            nTex.wrapMode = source.wrapMode;

            RenderTexture rt = RenderTexture.GetTemporary(newWidth, newHeight);
            rt.filterMode = FilterMode.Point;
            source.filterMode = FilterMode.Point;

            RenderTexture.active = rt;
            Graphics.Blit(source, rt);

            // GPU Texture copy doesn't work for the Asset Bundles Converter since Application.isPlaying is false
            bool supportsGPUTextureCopy = Application.isPlaying && SystemInfo.copyTextureSupport != CopyTextureSupport.None;

            if (supportsGPUTextureCopy && useGPUCopy) { Graphics.CopyTexture(rt, nTex); }
            else
            {
                nTex.ReadPixels(new Rect(0, 0, newWidth, newHeight), 0, 0);
                nTex.Apply();
            }

            RenderTexture.ReleaseTemporary(rt);
            RenderTexture.active = null;

            return nTex;
        }

        public static string NicifyName(string name)
        {
            // Some invalid file name chars differ between platforms so we have additional ones defined below
            foreach (char c in Path.GetInvalidFileNameChars()) { name = name.Replace(c, '_'); }
            name = name.Replace(":", "_");
            name = name.Replace(" ", "_");
            name = name.Replace("*", "_");
            name = name.Replace("|", "_");
            name = name.Replace(".", "_");
            name = name.Replace("?", "_");
            name = name.Replace("¿", "_");

            if (string.IsNullOrEmpty(name))
                name = "unnamed";

            return name;
        }

        public static string EnsureStartWithSlash(string path) =>
            !path.StartsWith('/') ? $"/{path}" : path;

        /// <summary>
        /// Checks if a filename indicates an emote asset based on the naming convention.
        /// </summary>
        public static bool IsEmoteFileName(string fileName) =>
            fileName.ToLower().EndsWith("_emote.glb");
    }

    public static class AssetInstantiator
    {
        public static GameObject InstanceGameObject(GameObject prefabGLTF)
        {
            GameObject clone = (GameObject)PrefabUtility.InstantiatePrefab(prefabGLTF);
            var renderers = clone.GetComponentsInChildren<Renderer>(true);

            foreach (Renderer renderer in renderers)
            {
                if (renderer.name.ToLower().Contains("_collider"))
                    renderer.enabled = false;
            }
            return clone;
        }
    }
}
