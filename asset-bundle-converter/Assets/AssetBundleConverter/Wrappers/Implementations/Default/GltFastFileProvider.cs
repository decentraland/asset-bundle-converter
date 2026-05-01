using DCL.ABConverter;
using GLTFast;
using GLTFast.Editor;
using System;
using System.IO;
using System.Threading.Tasks;
using GLTFast.Loading;
using System.Collections.Generic;
using UnityEditor;
using UnityEngine;

namespace AssetBundleConverter.Wrappers.Implementations.Default
{
#pragma warning disable 1998

    internal class SyncFileLoader : IDownload
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

    internal static class GltfGlobals
    {
        /// <summary>
        /// First four bytes of a glTF-Binary file are made up of this signature
        /// Represents glTF in ASCII
        /// </summary>
        private const uint GLB_MAGIC = 0x46546c67;

        /// <summary>
        /// Figures out if a byte array contains data of a glTF-Binary
        /// </summary>
        /// <param name="data">data buffer</param>
        /// <returns>True if the data is a glTF-Binary, false otherwise</returns>
        public static bool IsGltfBinary(byte[] data)
        {
            if (data is null or { Length: 0 })
                return true;

            var magic = BitConverter.ToUInt32(data, 0);
            return magic == GLB_MAGIC;
        }
    }

    internal class SyncTextureLoader : SyncFileLoader, ITextureDownload
    {
        public Texture2D Texture { get; }

        public override bool Success => Texture != null;

        public IDisposableTexture GetTexture(bool forceSampleLinear) =>
            new NonReusableTexture(Texture);

        public SyncTextureLoader(Uri url)
            : base(url)
        {
            Texture = AssetDatabase.LoadAssetAtPath<Texture2D>(url.OriginalString);

            if (Texture == null) { Error = $"Couldn't load texture at {url.OriginalString}"; }
        }

        // Used by the placeholder path: the caller already has a Texture2D in
        // memory (decoded from an embedded byte[] constant) so we bypass the
        // AssetDatabase lookup the URI-based ctor performs. `Success` reads
        // `Texture != null`, so an in-memory Texture2D produces a successful
        // ITextureDownload without ever touching the asset database.
        public SyncTextureLoader(Texture2D texture)
            : base(new Uri("placeholder://omitted-texture", UriKind.Absolute))
        {
            Texture = texture;
        }
    }

    /// <summary>
    /// Helpers that produce a 1×1 transparent placeholder Texture2D for image
    /// URIs the consumer-server flagged as omitted (see -partialOmittedUrisFile).
    /// Embedding the PNG bytes inline keeps the placeholder a real, decodeable
    /// PNG so GLTFast's MaterialGenerator binds a valid Texture2D to PBR slots
    /// (a null slot can crash or render magenta, depending on shader path).
    /// </summary>
    internal static class PlaceholderTexture
    {
        // Minimal 67-byte 1×1 fully-transparent RGBA PNG. Bytes can be
        // regenerated with:
        //   python3 -c 'import zlib,struct,sys; raw=b"\x00\x00\x00\x00\x00"; ihdr=struct.pack(">IIBBBBB",1,1,8,6,0,0,0); idat=zlib.compress(raw); sys.stdout.buffer.write(b"\x89PNG\r\n\x1a\n"+struct.pack(">I",13)+b"IHDR"+ihdr+struct.pack(">I",zlib.crc32(b"IHDR"+ihdr)&0xffffffff)+struct.pack(">I",len(idat))+b"IDAT"+idat+struct.pack(">I",zlib.crc32(b"IDAT"+idat)&0xffffffff)+struct.pack(">I",0)+b"IEND"+struct.pack(">I",zlib.crc32(b"IEND")&0xffffffff))'
        private static readonly byte[] PNG_BYTES_1X1_TRANSPARENT = new byte[]
        {
            0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A,
            0x00, 0x00, 0x00, 0x0D, 0x49, 0x48, 0x44, 0x52,
            0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
            0x08, 0x06, 0x00, 0x00, 0x00, 0x1F, 0x15, 0xC4,
            0x89, 0x00, 0x00, 0x00, 0x0D, 0x49, 0x44, 0x41,
            0x54, 0x78, 0x9C, 0x63, 0x60, 0x60, 0x60, 0x60,
            0x00, 0x00, 0x00, 0x05, 0x00, 0x01, 0x5E, 0xF3,
            0x2A, 0x3A, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45,
            0x4E, 0x44, 0xAE, 0x42, 0x60, 0x82
        };

        // Lazy-loaded singleton — Texture2D construction is cheap but the asset
        // is identical across every omitted URI, so we share one instance per
        // editor process. `LoadImage` mutates the texture's dimensions/format
        // to match the PNG header, so the (1,1) ctor params are placeholders.
        private static Texture2D cached;

        public static Texture2D Get()
        {
            if (cached == null)
            {
                cached = new Texture2D(1, 1, TextureFormat.RGBA32, false, true);
                cached.name = "placeholder_omitted_texture";
                cached.LoadImage(PNG_BYTES_1X1_TRANSPARENT);
            }
            return cached;
        }
    }

    public class GltFastFileProvider : IEditorDownloadProvider, IDisposable
    {
        // Table of contents, this is a mapping of the original path to the current absolute path
        // Example: { "models/Genesis_TX.png", "Assets/_Downloads/{hash}/{hash}.png" }
        private readonly Dictionary<string, string> contentTable;

        // Note (Kinerius): Since we can get multiple dependencies with the same name ( mostly textures ) we have to use the glb original root to determine which of them to use
        // for example 'models/Genesis_TX.png' and 'models/core_building/Genesis_TX.png', the importer is going to ask for Genesis_TX.png since its path is relative,
        // so we have to create a new path using the original root path that is already mapped by the asset bundle converter.
        private readonly string fileRootPath;
        private readonly string hash;
        // Lower-cased, leading-slash form (matches `GetDependenciesPaths` lookup
        // shape) of glTF image URIs the consumer-server flagged as known-missing
        // for THIS glb. When `RequestTextureAsync` is asked for one of these,
        // we return a transparent 1×1 placeholder instead of throwing — the rest
        // of the glb still imports. Buffers and unexpected texture misses still
        // throw so genuine infra failures stay loud. May be null (no partial-
        // omit info for this glb).
        private readonly HashSet<string> omittedTextureUris;
        private readonly List<GltfAssetDependency> gltfAssetDependencies = new ();

        public GltFastFileProvider(string fileRootPath, string hash, Dictionary<string, string> contentTable)
            : this(fileRootPath, hash, contentTable, null) { }

        public GltFastFileProvider(string fileRootPath, string hash, Dictionary<string, string> contentTable,
            HashSet<string> omittedTextureUris)
        {
            this.hash = hash;
            this.fileRootPath = fileRootPath;
            this.contentTable = contentTable;
            this.omittedTextureUris = omittedTextureUris;
        }

        public async Task<IDownload> RequestAsync(Uri url)
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

        public async Task<ITextureDownload> RequestTextureAsync(Uri url, bool nonReadable, bool forceLinear)
        {
            Uri rebuilt = RebuildUrl(url);

            // Check the omit set BEFORE GetDependenciesPaths throws, so the
            // expected-missing case never goes through the exception path. Match
            // against the same lower-cased leading-slash shape GetDependenciesPaths
            // uses for its contentTable lookup — SceneClient normalizes the omit
            // set to that form at parse time, so this is a plain string match.
            if (omittedTextureUris != null && omittedTextureUris.Count > 0)
            {
                string lookup = Utils.EnsureStartWithSlash(rebuilt.OriginalString).ToLower();
                if (omittedTextureUris.Contains(lookup))
                {
                    Debug.Log($"Returning transparent placeholder for omitted texture {lookup} in glb {hash}");
                    gltfAssetDependencies.Add(new GltfAssetDependency
                    {
                        assetPath = "<placeholder>",
                        originalUri = url.OriginalString,
                        type = GltfAssetDependency.Type.Texture
                    });
                    return new SyncTextureLoader(PlaceholderTexture.Get());
                }
            }

            Uri newUrl = GetDependenciesPaths(rebuilt);

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
            string relativePath = $"{fileRootPath}{absolutePath.Substring(absolutePath.IndexOf(hash, StringComparison.Ordinal) + hash.Length + 1)}";
            relativePath = relativePath.Replace("\\", "/");
            return new Uri(relativePath, UriKind.Relative);
        }

        private Uri GetDependenciesPaths(Uri url)
        {
            string originalPath = Utils.EnsureStartWithSlash(url.OriginalString).ToLower();
            bool isContained = contentTable.ContainsKey(originalPath);

            if (!isContained)
                throw new AssetNotMappedException(originalPath, hash);

            string finalPath = contentTable[originalPath];
            return new Uri(finalPath, UriKind.Relative);
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

    public class AssetNotMappedException : Exception
    {
        private readonly string missingDependency;
        private readonly string fileName;

        public AssetNotMappedException(string missingDependency, string fileName) : base(missingDependency)
        {
            this.missingDependency = missingDependency;
            this.fileName = fileName;
        }

        public override string Message => $"<b>{fileName}</b> will be skipped since one of its dependencies is missing: <b>{missingDependency}</b>";
    }
}
