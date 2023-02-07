using DCL.ABConverter;
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

            if (File.Exists(path)) { Data = File.ReadAllBytes(path); }
            else { Error = $"Cannot find resource at path {path}"; }
        }

        public virtual bool Success => Data != null;

        public string Error { get; protected set; }
        public byte[] Data { get; }

        public string Text => System.Text.Encoding.UTF8.GetString(Data);

        public bool? IsBinary
        {
            get
            {
                if (Success) { return GltfGlobals.IsGltfBinary(Data); }

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
        public Texture2D Texture { get; }

        public override bool Success => Texture != null;

        public SyncTextureLoader(Uri url)
            : base(url)
        {
            Texture = AssetDatabase.LoadAssetAtPath<Texture2D>(url.OriginalString);

            if (Texture == null) { Error = $"Couldn't load texture at {url.OriginalString}"; }
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
        private string fileRootPath;
        private string hash;
        private readonly List<GltfAssetDependency> gltfAssetDependencies = new ();

        public GltFastFileProvider(string fileRootPath, string hash, Dictionary<string, string> contentTable)
        {
            this.hash = hash;
            this.fileRootPath = fileRootPath;
            this.contentTable = contentTable;
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

            return new SyncTextureLoader(newUrl);
        }

        private Uri RebuildUrl(Uri url)
        {
            var absolutePath = url.OriginalString;
            string relativePath = $"{fileRootPath}{absolutePath.Substring(absolutePath.IndexOf(hash) + hash.Length + 1)}";
            relativePath = relativePath.Replace("\\", "/");
            return new Uri(relativePath, UriKind.Relative);
        }

        private Uri GetDependenciesPaths(Uri url)
        {
            try
            {
                string originalPath = Utils.EnsureStartWithSlash(url.OriginalString).ToLower();
                bool isContained = contentTable.ContainsKey(originalPath);

                if (!isContained)
                {
                    Debug.LogWarning(originalPath + " is not mapped!");

                    var pathe = originalPath.Substring(originalPath.IndexOf('/'));
                    var keys = contentTable.Keys.Where(k => k.ToLower().Contains(pathe.ToLower()));

                    foreach (string key in keys)
                        Debug.Log($" -> {key} ?");

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
