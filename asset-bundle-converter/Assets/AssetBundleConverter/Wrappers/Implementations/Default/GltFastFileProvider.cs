using System;
using System.IO;
using System.Threading.Tasks;
using GLTFast.Loading;
using UnityEditor;
using UnityEngine;

namespace AssetBundleConverter.Wrappers.Implementations.Default
{
#pragma warning disable 1998

    class SyncFileLoader : IDownload {
        public SyncFileLoader(Uri url) {
            var path = url.OriginalString;
            if (File.Exists(path)) {
                data = File.ReadAllBytes(path);
            }
            else {
                error = $"Cannot find resource at path {path}";
            }
        }
        
        public object Current => null;
        public bool MoveNext() { return false; }
        public void Reset() {}
        
        public virtual bool success => data!=null;

        public string error { get; protected set; }
        public byte[] data { get; }

        public string text => System.Text.Encoding.UTF8.GetString(data);

        public bool? isBinary {
            get {
                if (success) {
                    return GltfGlobals.IsGltfBinary(data);
                }
                return null;
            }
        }
    }
    
    static class GltfGlobals {
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
        public static bool IsGltfBinary(byte[] data) {
            var magic = BitConverter.ToUInt32( data, 0 );
            return magic == GLB_MAGIC;
        }
    }
    
    class SyncTextureLoader : SyncFileLoader, ITextureDownload {
        
        public Texture2D texture { get; }

        public override bool success => texture!=null;
        
        public SyncTextureLoader(Uri url, bool nonReadable)
            : base(url) {
            texture = AssetDatabase.LoadAssetAtPath<Texture2D>(url.OriginalString);
            if (texture == null) {
                error = $"Couldn't load texture at {url.OriginalString}";
            }
        }
    }
    
    public class GltFastFileProvider : IDownloadProvider, IDisposable
    {
        public delegate Uri FileNameToUrl(Uri fileName);

        private FileNameToUrl fileToUrl;
        public GltFastFileProvider(FileNameToUrl fileToUrl) { this.fileToUrl = fileToUrl; }
        public async Task<IDownload> Request(Uri url)
        {
            return new SyncFileLoader(url);
        }
        public async Task<ITextureDownload> RequestTexture(Uri url, bool nonReadable)
        {
            Uri newUrl = fileToUrl(url);
            return new SyncTextureLoader(newUrl, nonReadable);
        }
        
        public void Dispose() { /*shrug*/ }
    }
}