using System;
using System.Threading.Tasks;
using GLTFast.Editor;
using GLTFast.Loading;

namespace AssetBundleConverter.Wrappers.Implementations.Default
{
#pragma warning disable 1998

    public class GltFastFileProvider : IDownloadProvider, IDisposable
    {
        public delegate string FileNameToUrl(string fileName);

        private FileNameToUrl fileToUrl;
        public GltFastFileProvider(FileNameToUrl fileToUrl) { this.fileToUrl = fileToUrl; }
        public async Task<IDownload> Request(Uri url)
        {
            return new SyncFileLoader(url);
        }
        public async Task<ITextureDownload> RequestTexture(Uri url, bool nonReadable)
        {
            string fileName = url.AbsolutePath.Substring(url.AbsolutePath.LastIndexOf('/') + 1);
            string newUrl = fileToUrl(fileName);
            var uri = new Uri(newUrl, UriKind.Relative);

            return new SyncTextureLoader(uri, nonReadable);
        }
        
        public void Dispose() { /*shrug*/ }
    }
}