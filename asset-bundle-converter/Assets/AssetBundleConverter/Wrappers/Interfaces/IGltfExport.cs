using System;
using System.Threading.Tasks;
using UnityEngine;

namespace AssetBundleConverter.Wrappers.Interfaces
{
    public interface IGltfExport : IDisposable
    {
        /// <summary>
        /// Exports a GameObject to a GLB file
        /// </summary>
        /// <param name="gameObject">The GameObject to export</param>
        /// <param name="filePath">Destination file path</param>
        /// <returns>True if export was successful</returns>
        Task<bool> ExportToGlb(GameObject gameObject, string filePath);
    }
}
