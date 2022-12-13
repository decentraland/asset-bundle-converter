using GLTFast;
using GLTFast.Editor;
using System;
using System.IO;
using System.Threading.Tasks;
using GLTFast.Loading;
using System.Collections.Generic;
using System.Linq;
using UnityEditor;
using UnityEngine;

namespace AssetBundleConverter.Wrappers.Implementations.Default
{
#pragma warning disable 1998

    class SyncFileLoader : IDownload
    {
        public SyncFileLoader(Uri url)
        {
            var path = url.OriginalString;

            if (File.Exists(path)) { data = File.ReadAllBytes(path); }
            else { error = $"Cannot find resource at path {path}"; }
        }

        public object Current => null;

        public bool MoveNext()
        {
            return false;
        }

        public void Reset() { }

        public virtual bool success => data != null;

        public string error { get; protected set; }
        public byte[] data { get; }

        public string text => System.Text.Encoding.UTF8.GetString(data);

        public bool? isBinary
        {
            get
            {
                if (success) { return GltfGlobals.IsGltfBinary(data); }

                return null;
            }
        }

        public void Dispose() { }
    }

    static class GltfGlobals
    {
        /// <summary>
        /// First four bytes of a glTF-Binary file are made up of this signature
        /// Represents glTF in ASCII
        /// </summary>
        internal const uint GLB_MAGIC = 0x46546c67;

        /// <summary>
        /// Figures out if a byte array contains data of a glTF-Binary
        /// </summary>
        /// <param name="data">data buffer</param>
        /// <returns>True if the data is a glTF-Binary, false otherwise</returns>
        public static bool IsGltfBinary(byte[] data)
        {
            var magic = BitConverter.ToUInt32(data, 0);
            return magic == GLB_MAGIC;
        }
    }

    class SyncTextureLoader : SyncFileLoader, ITextureDownload
    {
        public Texture2D texture { get; }

        public override bool success => texture != null;

        public SyncTextureLoader(Uri url, bool nonReadable)
            : base(url)
        {
            texture = AssetDatabase.LoadAssetAtPath<Texture2D>(url.OriginalString);

            if (texture == null) { error = $"Couldn't load texture at {url.OriginalString}"; }
        }
    }

    public class GltFastFileProvider : IEditorDownloadProvider, IDisposable
    {
        // Table of contents, this is a mapping of the original path to the current absolute path
        // Example: { "models/Genesis_TX.png", "Assets/_Downloads/{hash}/{hash}.png" }
        private readonly Dictionary<string, string> contentTable;

        // Note (Kinerius): Since we can get multiple dependencies with the same name ( mostly textures ) we have to use the glb original root to determine which of them to use
        // for example 'models/Genesis_TX.png' and 'models/core_building/Genesis_TX.png', the importer is going to ask for Genesis_TX.png since its path is relative
        // so we have to create a new path using the original root path that is already mapped by the asset bundle converter.
        private readonly string originalRootPath;
        private readonly List<GltfAssetDependency> gltfAssetDependencies = new ();

        public GltFastFileProvider(string originalFilePath, Dictionary<string, string> contentTable)
        {
            this.contentTable = contentTable;
            var normalized = originalFilePath.Replace("\\", "/");
            var separated = normalized.Split("/").ToList();
            separated.RemoveAt(separated.Count - 1);
            originalRootPath = string.Join('/', separated);
        }

        public async Task<IDownload> Request(Uri url)
        {
            Uri newUrl = GetDependenciesPaths(RebuildUrl(url));

            gltfAssetDependencies.Add(new GltfAssetDependency
            {
                assetPath = newUrl.OriginalString,
                originalUri = url.OriginalString,
                type = GltfAssetDependency.Type.Buffer
            });

            return new SyncFileLoader(newUrl);
        }

        public async Task<ITextureDownload> RequestTexture(Uri url, bool nonReadable)
        {
            Uri newUrl = GetDependenciesPaths(RebuildUrl(url));

            gltfAssetDependencies.Add(new GltfAssetDependency
            {
                assetPath = newUrl.OriginalString,
                originalUri = url.OriginalString,
                type = GltfAssetDependency.Type.Texture
            });

            return new SyncTextureLoader(newUrl, nonReadable);
        }

        private Uri RebuildUrl(Uri url)
        {
            string normalizedString = url.OriginalString.Replace('\\', '/');
            string fileName = normalizedString.Substring(normalizedString.LastIndexOf('/') + 1);
            return new Uri($"{originalRootPath}/{fileName}", UriKind.Relative);
        }

        private Uri GetDependenciesPaths(Uri url)
        {
            try
            {
                string originalPath = url.OriginalString;
                bool isContained = contentTable.ContainsKey(originalPath);

                if (!isContained)
                {
                    Debug.LogWarning(originalPath + " is not mapped!");
                    return new Uri(originalPath, UriKind.Relative);
                }

                string finalPath = contentTable[originalPath];
                return new Uri(finalPath, UriKind.Relative);
            }
            catch (Exception)
            {
                Debug.LogError($"Failed to transform path: {url.OriginalString}");
                return url;
            }
        }

        public void Dispose()
        {
            /*shrug*/
        }

        public List<GltfAssetDependency> assetDependencies
        {
            get => gltfAssetDependencies;

            set { }
        }
    }
}
