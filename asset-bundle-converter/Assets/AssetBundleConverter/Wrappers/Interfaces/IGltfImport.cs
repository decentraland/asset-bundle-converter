using GLTFast;
using GLTFast.Logging;
using System.Threading.Tasks;
using UnityEngine;

namespace AssetBundleConverter.Wrappers.Interfaces
{
    public interface IGltfImport
    {
        Task Load(string gltfUrl, ImportSettings importSettings);

        bool LoadingDone { get; }
        bool LoadingError { get; }
        LogCode LastErrorCode { get; }
        int TextureCount { get; }
        int MaterialCount { get; }

        Texture2D GetTexture(int index);

        Material GetMaterial(int index);

        void Dispose();

        Material defaultMaterial { get; }


    }
}
