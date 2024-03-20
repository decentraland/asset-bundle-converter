using AssetBundleConverter.Wrappers.Interfaces;
using GLTFast;
using GLTFast.Logging;
using GLTFast.Materials;
using System;
using System.Collections.Generic;
using System.Threading.Tasks;
using UnityEngine;

namespace AssetBundleConverter.Wrappers.Implementations.Default
{
    public class GltfImportWrapper : IGltfImport
    {
        private readonly GltfImport importer;
        private readonly ConsoleLogger logger;
        private readonly IMaterialGenerator materialGenerator;
        private readonly GltFastFileProvider fileProvider;

        public GltfImportWrapper(GltFastFileProvider gltFastFileProvider, UninterruptedDeferAgent uninterruptedDeferAgent, IMaterialGenerator materialGenerator, ConsoleLogger consoleLogger)
        {
            logger = consoleLogger;
            fileProvider = gltFastFileProvider;
            this.materialGenerator = materialGenerator;
            importer = new GltfImport(gltFastFileProvider, uninterruptedDeferAgent, this.materialGenerator, logger);
        }

        public async Task Load(string gltfUrl, ImportSettings importSettings) =>
            await importer.Load(gltfUrl, importSettings);

        public bool LoadingDone => importer.LoadingDone;
        public bool LoadingError => importer.LoadingError;
        public LogCode LastErrorCode => logger.LastErrorCode;
        public int TextureCount => importer.TextureCount;
        public int MaterialCount => importer.MaterialCount;

        public Texture2D GetTexture(int index) =>
            importer.GetTexture(index);

        public Material GetMaterial(int index) =>
            importer.GetMaterial(index);

        public IReadOnlyList<AnimationClip> GetClips() =>
            importer.GetAnimationClips();

        public void Dispose()
        {
            importer.Dispose();
        }

        public Material defaultMaterial
        {
            get
            {
                if (importer.defaultMaterial == null)
                    importer.defaultMaterial = materialGenerator.GetDefaultMaterial();

                return importer.defaultMaterial;
            }
        }
    }
}
