using AssetBundleConverter.Wrappers.Interfaces;
using GLTFast.Export;
using GLTFast.Logging;
using System;
using System.Threading.Tasks;
using UnityEngine;

namespace AssetBundleConverter.Wrappers.Implementations.Default
{
    public class GltfExportWrapper : IGltfExport
    {
        private readonly ICodeLogger logger;
        private GameObjectExport exporter;
        private readonly ExportSettings exportSettings;
        private readonly GameObjectExportSettings gameObjectExportSettings;

        public GltfExportWrapper(ExportSettings exportSettings = null, GameObjectExportSettings gameObjectExportSettings = null, ICodeLogger logger = null)
        {
            this.logger = logger ?? new ConsoleLogger();
            this.exportSettings = exportSettings ?? CreateDefaultExportSettings();
            this.gameObjectExportSettings = gameObjectExportSettings ?? CreateDefaultGameObjectExportSettings();
        }

        /// <summary>
        /// Creates default export settings aligned with standard import behavior
        /// </summary>
        private ExportSettings CreateDefaultExportSettings()
        {
            return new ExportSettings
            {
                Format = GltfFormat.Binary,
                FileConflictResolution = FileConflictResolution.Overwrite,
            };
        }

        /// <summary>
        /// Creates default GameObject export settings
        /// </summary>
        private GameObjectExportSettings CreateDefaultGameObjectExportSettings()
        {
            return new GameObjectExportSettings
            {
                OnlyActiveInHierarchy = false,
                DisabledComponents = true,
                LayerMask = ~0 // Include all layers
            };
        }

        /// <summary>
        /// Exports a GameObject to a GLB file
        /// </summary>
        /// <param name="gameObject">The GameObject to export</param>
        /// <param name="filePath">Destination file path</param>
        /// <returns>True if export was successful</returns>
        public async Task<bool> ExportToGlb(GameObject gameObject, string filePath)
        {
            if (gameObject == null)
            {
                Debug.LogError("Cannot export null GameObject");
                return false;
            }

            try
            {
                // Create a new exporter for each export operation
                exporter = new GameObjectExport(
                    exportSettings,
                    gameObjectExportSettings,
                    logger: logger
                );

                // Add the GameObject to the export
                bool sceneAdded = exporter.AddScene(new[] { gameObject }, gameObject.name);
                if (!sceneAdded)
                {
                    Debug.LogError($"Failed to add scene for export: {gameObject.name}");
                    return false;
                }

                // Save to file and dispose the exporter
                bool success = await exporter.SaveToFileAndDispose(filePath);

                if (success)
                    Debug.Log($"Successfully exported GameObject to {filePath}");
                else
                    Debug.LogError($"Failed to export to {filePath}");

                return success;
            }
            catch (Exception e)
            {
                Debug.LogException(e);
                return false;
            }
        }

        /// <summary>
        /// Disposes resources used by the exporter
        /// </summary>
        public void Dispose()
        {
            exporter = null;
        }
    }
}
