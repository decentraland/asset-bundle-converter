﻿using AssetBundleConverter;
using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Net.Http;
using System.Text.RegularExpressions;
using System.Threading.Tasks;
using AssetBundleConverter.Editor;
using AssetBundleConverter.Wrappers.Implementations.Default;
using AssetBundleConverter.Wrappers.Interfaces;
using GLTFast;
using System.Diagnostics;
using UnityEditor;
using UnityEditor.Animations;
using UnityEngine;
using UnityEngine.Networking;
using UnityEngine.Profiling;
using UnityEngine.Rendering.Universal;
using Debug = UnityEngine.Debug;
using Environment = AssetBundleConverter.Environment;
using Object = UnityEngine.Object;

namespace DCL.ABConverter
{
    public class AssetBundleConverter
    {
        public struct ConversionParams
        {
            public IReadOnlyList<ContentServerUtils.MappingPair> rawContents;
            public string entityType;
        }

        private struct GltfImportSettings
        {
            public string url;
            public IGltfImport import;
            public AssetPath AssetPath;
        }

        // For consistency, never remove any of these enum values as it will break old error codes
        public enum ErrorCodes
        {
            SUCCESS,
            UNDEFINED,
            SCENE_LIST_NULL,
            ASSET_BUNDLE_BUILD_FAIL,
            VISUAL_TEST_FAILED,
            UNEXPECTED_ERROR,
            GLTFAST_CRITICAL_ERROR,
            GLTF_IMPORTER_NOT_FOUND,
            EMBED_MATERIAL_FAILURE,
            DOWNLOAD_FAILED,
            INVALID_PLATFORM,
            GLTF_PROCESS_MISMATCH,
        }

        public class State
        {
            public enum Step
            {
                IDLE,
                DUMPING_ASSETS,
                BUILDING_ASSET_BUNDLES,
                FINISHED,
            }

            public Step step { get; internal set; }
            public ErrorCodes lastErrorCode { get; internal set; }
        }

        private const float MAX_TEXTURE_SIZE = 512f;

        private const string VERSION = "7.0";

        private readonly Dictionary<string, string> lowerCaseHashes = new ();
        public State CurrentState { get; } = new ();
        private Environment env;
        private ClientSettings settings;
        private readonly string finalDownloadedPath;
        private readonly string finalDownloadedAssetDbPath;
        private List<AssetPath> assetsToMark = new ();
        private List<GltfImportSettings> gltfToWait = new ();
        private Dictionary<string, string> contentTable = new ();
        private Dictionary<string, string> gltfOriginalNames = new ();
        private string logBuffer;
        private int totalAssets;
        private int skippedAssets;
        private IErrorReporter errorReporter;

        private double conversionStartupTime;
        private double downloadStartupTime;
        private double downloadEndTime;
        private double nonGltfImportStartupTime;
        private double nonGltfImportEndTime;
        private double importStartupTime;
        private double importEndTime;
        private double bundlesStartupTime;
        private double bundlesEndTime;
        private double visualTestStartupTime;
        private double visualTestEndTime;
        private double startupAllocated;
        private double startupReserved;
        private int totalGltfsToProcess;
        private int totalGltfsProcessed;

        private bool isExitForced = false;
        private IABLogger log => env.logger;
        private Dictionary<AssetPath, byte[]> downloadedData = new();
        private string entityType;

        public AssetBundleConverter(Environment env, ClientSettings settings)
        {
            this.settings = settings;
            this.env = env;
            PlatformUtils.currentTarget = settings.buildTarget;

            errorReporter = env.errorReporter;
            if (this.settings.reportErrors)
                errorReporter.Enable();

            finalDownloadedPath = Config.GetDownloadPath();
            finalDownloadedAssetDbPath = PathUtils.FixDirectorySeparator(Config.ASSET_BUNDLES_PATH_ROOT + Config.DASH);

            log.verboseEnabled = true;
        }

        /// <summary>
        /// Entry point of the AssetBundleConverter
        /// </summary>
        /// <param name="conversionParams"></param>
        /// <returns></returns>
        public async Task ConvertAsync(ConversionParams conversionParams)
        {
            var rawContents = conversionParams.rawContents;
            entityType = conversionParams.entityType;
            startupAllocated = Profiler.GetTotalAllocatedMemoryLong() / 100000.0;
            startupReserved = Profiler.GetTotalReservedMemoryLong() / 100000.0;

            if (settings.buildTarget is not (BuildTarget.WebGL or BuildTarget.StandaloneWindows64 or BuildTarget.StandaloneOSX))
            {
                var message = $"Build target is invalid: {settings.buildTarget.ToString()}";
                log.Error(message);
                errorReporter.ReportError(message, settings);
                ForceExit((int)ErrorCodes.INVALID_PLATFORM);
                return;
            }

            if (!env.editor.SwitchBuildTarget(settings.buildTarget))
                return;

            log.verboseEnabled = settings.verbose;
            await env.editor.LoadVisualTestSceneAsync();

            conversionStartupTime = EditorApplication.timeSinceStartup;
            log.Info("Starting a new conversion");

            // First step: initialize directories to download the original assets and to store the results
            InitializeDirectoryPaths(settings.clearDirectoriesOnStart, settings.clearDirectoriesOnStart);
            AdjustRenderingMode(settings.buildTarget);
            env.assetDatabase.Refresh();

            await env.editor.Delay(TimeSpan.FromSeconds(0.1f));

            // Second step: we download all assets
            PopulateLowercaseMappings(rawContents);

            if (settings.importGltf)
            {

                if (!await DownloadAssets(rawContents))
                {
                    log.Info("All assets are already converted");
                    OnFinish();

                    return;
                }

            }

            // Third step: we import gltfs
            importStartupTime = EditorApplication.timeSinceStartup;

            if (isExitForced)
                return;

            if (await ProcessAllGltfs())
            {
                OnFinish();

                return;
            }

            if (isExitForced)
                return;

            importEndTime = EditorApplication.timeSinceStartup;

            EditorUtility.ClearProgressBar();

            if (totalGltfsProcessed != totalGltfsToProcess)
            {
                var message = $"GLTF count mismatch GLTF to process: {totalGltfsToProcess} vs GLTF processed: {totalGltfsProcessed}";
                log.Error(message);
                errorReporter.ReportError(message, settings);
                ForceExit((int)ErrorCodes.GLTF_PROCESS_MISMATCH);
                return;
            }

            if (settings.createAssetBundle)
            {
                GC.Collect();

                bundlesStartupTime = EditorApplication.timeSinceStartup;

                MarkAndBuildForTarget(settings.buildTarget);

                bundlesEndTime = EditorApplication.timeSinceStartup;
            }

            if (isExitForced)
                return;

            if (settings.visualTest)
            {
                visualTestStartupTime = EditorApplication.timeSinceStartup;
                await env.editor.TestConvertedAssetsAsync(env, settings, assetsToMark, errorReporter);
                visualTestEndTime = EditorApplication.timeSinceStartup;
            }

            OnFinish();
        }

        private void AdjustRenderingMode(BuildTarget targetPlatform)
        {
            var universalRendererData = Resources.FindObjectsOfTypeAll<UniversalRendererData>().First();
            var rendererDataPath = AssetDatabase.GetAssetPath(universalRendererData);

            universalRendererData.renderingMode = targetPlatform switch
                                                  {
                                                      BuildTarget.StandaloneWindows64 or BuildTarget.StandaloneOSX => RenderingMode.ForwardPlus,
                                                      BuildTarget.WebGL => RenderingMode.Forward,
                                                      _ => universalRendererData.renderingMode
                                                  };

            AssetDatabase.ImportAsset(rendererDataPath);
        }

        private void MarkAndBuildForTarget(BuildTarget target)
        {

            // Fourth step: we mark all assets for bundling
            MarkAllAssetBundles(assetsToMark, target);

            // Fifth step: we build the Asset Bundles
            env.assetDatabase.Refresh();
            env.assetDatabase.SaveAssets();
            CurrentState.step = State.Step.BUILDING_ASSET_BUNDLES;

            if (BuildAssetBundles(target, out var manifest))
            {
                CleanAssetBundleFolder(manifest.GetAllAssetBundles());

                CurrentState.lastErrorCode = ErrorCodes.SUCCESS;
                CurrentState.step = State.Step.FINISHED;
            }
            else
            {
                CurrentState.lastErrorCode = ErrorCodes.ASSET_BUNDLE_BUILD_FAIL;
                CurrentState.step = State.Step.FINISHED;
            }
        }

        /// <summary>
        /// During this step we import gltfs into the scene and then we import the gltf so it can be marked for AB conversion
        /// </summary>
        /// <returns></returns>
        private Stopwatch embedExtractTextureTime;
        private Stopwatch embedExtractMaterialTime;
        private Stopwatch configureGltftime;
        private async Task<bool> ProcessAllGltfs()
        {
            embedExtractTextureTime = new Stopwatch();
            embedExtractMaterialTime = new Stopwatch();
            configureGltftime = new Stopwatch();
            var totalGltfToLoad = gltfToWait.Count;
            var loadedGltf = 0;

            // Its expected to have errors here since unity will try to import gltf's without our custom settings
            // this step is required to grab the gltfImporter and change its values
            RefreshAssetsWithNoLogs();

            ContentMap[] contentMap = contentTable.Select(kvp => new ContentMap(kvp.Key, kvp.Value)).ToArray();

            AnimationMethod animationMethod = GetAnimationMethod();

            var importSettings = new ImportSettings
            {
                AnimationMethod = animationMethod,
                NodeNameMethod = NameImportMethod.OriginalUnique,
                AnisotropicFilterLevel = 0,
                GenerateMipMaps = false
            };

            foreach (GltfImportSettings gltf in gltfToWait)
            {
                if (isExitForced) break;

                var gltfUrl = gltf.url;
                var gltfImport = gltf.import;

                try
                {
                    env.editor.DisplayProgressBar("Asset Bundle Converter", $"Loading GLTF {gltfUrl}",
                        loadedGltf / (float)totalGltfToLoad);

                    loadedGltf++;
                    log.Verbose($"Starting to import gltf {gltfUrl}");

                    await gltfImport.Load(gltfUrl, importSettings);

                    var loadingSuccess = gltfImport.LoadingDone && !gltfImport.LoadingError;
                    var color = loadingSuccess ? "green" : "red";

                    if (!loadingSuccess)
                    {
                        var message = $"GLTF is invalid or contains errors: {gltfImport.LastErrorCode}";
                        log.Error(message);
                        errorReporter.ReportError(message, settings);
                        continue;
                    }

                    var relativePath = PathUtils.FullPathToAssetPath(gltfUrl);
                    var textures = new List<Texture2D>();

                    for (int i = 0; i < gltfImport.TextureCount; i++)
                        textures.Add(gltfImport.GetTexture(i));

                    embedExtractTextureTime.Start();

                    string directory = Path.GetDirectoryName(relativePath);

                    if (textures.Count > 0)
                    {
                        textures = ExtractEmbedTexturesFromGltf(textures, directory);
                    }

                    embedExtractTextureTime.Stop();

                    embedExtractMaterialTime.Start();
                    ExtractEmbedMaterialsFromGltf(textures, gltf, gltfImport, gltfUrl);
                    embedExtractMaterialTime.Stop();

                    if (animationMethod == AnimationMethod.Mecanim)
                    {
                        CreateAnimatorController(gltfImport, directory);
                    }

                    log.Verbose($"Importing {relativePath}");

                    configureGltftime.Start();
                    bool importerSuccess = env.gltfImporter.ConfigureImporter(relativePath, contentMap, gltf.AssetPath.fileRootPath, gltf.AssetPath.hash, settings.shaderType, animationMethod);
                    configureGltftime.Stop();

                    if (importerSuccess)
                    {
                        GameObject importedGameObject = env.assetDatabase.LoadAssetAtPath<GameObject>(relativePath);

                        if (importedGameObject == null)
                        {
                            var message = "Fatal error when importing this object, check previous error messages";
                            log.Error(message);
                            errorReporter.ReportError(message, settings);
                            ForceExit((int)ErrorCodes.GLTFAST_CRITICAL_ERROR);
                            break;
                        }
                    }
                    else
                    {
                        var message = $"Failed to get the gltf importer for {gltfUrl} \nPath: {relativePath}";
                        log.Error(message);
                        errorReporter.ReportError(message, settings);
                        ForceExit((int)ErrorCodes.GLTF_IMPORTER_NOT_FOUND);
                        continue;
                    }

                    if ((!settings.createAssetBundle || !settings.visualTest) && settings.placeOnScene)
                    {
                        GameObject originalGltf = env.assetDatabase.LoadAssetAtPath<GameObject>(relativePath);

                        if (originalGltf != null)
                            try
                            {
                                var clone = (GameObject)PrefabUtility.InstantiatePrefab(originalGltf);
                                var renderers = clone.GetComponentsInChildren<Renderer>(true);

                                foreach (Renderer renderer in renderers)
                                    if (renderer.name.ToLower().Contains("_collider"))
                                        renderer.enabled = false;
                            }
                            catch (Exception e)
                            {
                                log.Exception(e.ToString());
                                continue;

                                // we dont crash here since we dont do this on batch mode
                            }
                    }

                    log.Verbose($"<color={color}>Ended loading gltf {gltfUrl} with result <b>{loadingSuccess}</b></color>");
                }

                // This case handles a missing asset, most likely creator's fault, gltf will be skipped
                catch (AssetNotMappedException e) { Debug.LogError($"<b>{gltf.AssetPath.fileName}</b> will be skipped since one of its dependencies is missing: <b>{e.Message}</b>"); }
                catch (Exception e)
                {
                    log.Error("UNCAUGHT FATAL: Failed to load GLTF " + gltf.AssetPath.hash);
                    Debug.LogException(e);
                    errorReporter.ReportException(new ConversionException(ConversionStep.Import, settings, e));
                    ForceExit((int)ErrorCodes.GLTFAST_CRITICAL_ERROR);
                    break;
                }
                finally
                {
                    gltfImport.Dispose();
                }

                totalGltfsProcessed++;
            }

            EditorUtility.ClearProgressBar();

            log.Info("Ended importing GLTFs");

            return false;
        }

        private void CreateAnimatorController(IGltfImport gltfImport, string directory)
        {
            var animatorRoot = $"{directory}/Animator/";

            if (!env.directory.Exists(animatorRoot))
                env.directory.CreateDirectory(animatorRoot);

            var filePath = $"{animatorRoot}animatorController.controller";
            var controller = AnimatorController.CreateAnimatorControllerAtPath(filePath);
            var clips = gltfImport.GetClips();

            var rootStateMachine = controller.layers[0].stateMachine;

            foreach (AnimationClip animationClip in clips)
            {
                // copy the animation asset so we dont use the same references that will get disposed
                var newCopy = Object.Instantiate(animationClip);
                newCopy.name = animationClip.name;

                // embed clip into the animatorController
                AssetDatabase.AddObjectToAsset(newCopy, controller);
                AssetDatabase.ImportAsset(AssetDatabase.GetAssetPath(newCopy));

                // configure the animator
                string animationClipName = newCopy.name;
                controller.AddParameter(animationClipName, AnimatorControllerParameterType.Trigger);
                var state = controller.AddMotion(newCopy, 0);
                var anyStateTransition = rootStateMachine.AddAnyStateTransition(state);
                anyStateTransition.AddCondition(AnimatorConditionMode.If, 0, animationClipName);
                anyStateTransition.duration = 0;
            }

            AssetDatabase.SaveAssets();
            AssetDatabase.Refresh();
        }

        private AnimationMethod GetAnimationMethod()
        {
            if (!entityType.ToLower().Contains("emote")) return AnimationMethod.Legacy;
            return settings.buildTarget is BuildTarget.StandaloneWindows64 or BuildTarget.StandaloneOSX ? AnimationMethod.Mecanim : AnimationMethod.Legacy;
        }

        private void ExtractEmbedMaterialsFromGltf(List<Texture2D> textures, GltfImportSettings gltf, IGltfImport gltfImport, string gltfUrl)
        {
            Profiler.BeginSample("ExtractEmbedMaterials");
            Dictionary<string, Texture2D> texNameMap = new Dictionary<string, Texture2D>();

            foreach (var texture in textures.Where(texture => texture != null))
                texNameMap[texture.name.ToLowerInvariant()] = texture;

            var folder = gltf.AssetPath.assetFolder;
            var materialDirectory = $"{folder}Materials{Path.DirectorySeparatorChar}";
            env.directory.CreateDirectory(materialDirectory);

            if (gltfImport.defaultMaterial != null)
            {
                var mat = gltfImport.defaultMaterial;
                CreateMaterialAsset(mat, materialDirectory, texNameMap);
            }

            for (var t = 0; t < gltfImport.MaterialCount; t++)
            {
                var originalMaterial = gltfImport.GetMaterial(t);
                CreateMaterialAsset(originalMaterial, materialDirectory, texNameMap);
            }

            Profiler.EndSample();
            log.Verbose($"gltf creating dummy materials completed: {gltfUrl}");
            RefreshAssetsWithNoLogs();
        }

        private void CreateMaterialAsset(Material originalMaterial, string materialRoot, Dictionary<string, Texture2D> texNameMap)
        {
            string matName = Utils.NicifyName(originalMaterial.name);

            string materialPath =
                PathUtils.GetRelativePathTo(Application.dataPath, string.Concat(materialRoot, matName, ".mat"));

            var newMaterial = Object.Instantiate(originalMaterial);

            var shader = newMaterial.shader;

            if (settings.stripShaders)
                env.assetDatabase.AssignAssetBundle(shader, settings.includeShaderVariants);

            var textureProperties = GetTextureProperties(shader);

            Profiler.BeginSample("ExtractEmbedMaterials.SetTexture");
            for (var i = 0; i < textureProperties.Count; ++i)
            {
                int propertyId = textureProperties[i];

                // we reassign the texture reference
                var prevTexture = newMaterial.GetTexture(propertyId);

                // after copying a material it should hold the reference to the original texture
                if (!prevTexture) continue;

                string texName = Utils.NicifyName(prevTexture.name);
                texName = Path.GetFileNameWithoutExtension(texName).ToLowerInvariant();

                if (texNameMap.TryGetValue(texName, out Texture2D tex))
                    newMaterial.SetTexture(propertyId, tex);
            }

            Profiler.BeginSample("ExtractEmbedMaterials.CreateAsset");
            env.assetDatabase.CreateAsset(newMaterial, materialPath);
            //env.assetDatabase.SaveAssets();
            Profiler.EndSample();

            Profiler.EndSample();

            EditorUtility.SetDirty(newMaterial);
        }

        private readonly Dictionary<Shader, List<int>> textureProperties = new ();
        private List<int> GetTextureProperties(Shader shader)
        {
            Profiler.BeginSample("GetTextureProperties");

            if (!textureProperties.ContainsKey(shader))
            {
                int count = ShaderUtil.GetPropertyCount(shader);
                List<int> properties = new ();
                for (var i = 0; i < count; ++i)
                {
                    ShaderUtil.ShaderPropertyType shaderPropertyType = ShaderUtil.GetPropertyType(shader, i);

                    if (shaderPropertyType != ShaderUtil.ShaderPropertyType.TexEnv)
                        continue;

                    string propertyName = ShaderUtil.GetPropertyName(shader, i);
                    properties.Add(Shader.PropertyToID(propertyName));
                }

                textureProperties[shader] = properties;
            }

            Profiler.EndSample();
            return textureProperties[shader];
        }

        /// <summary>
        /// When we do the first refresh for GLTFs we are going to get plenty of errors because of missing textures, we dont want that noise since its intended.
        /// </summary>
        private static void RefreshAssetsWithNoLogs()
        {
            Debug.unityLogger.logEnabled = false;
            AssetDatabase.Refresh();
            Debug.unityLogger.logEnabled = true;
        }

        private List<Texture2D> ExtractEmbedTexturesFromGltf(List<Texture2D> textures, string folderName)
        {
            var newTextures = new List<Texture2D>();

            if (textures.Count > 0)
            {
                var texturesRoot = $"{folderName}/Textures/";

                if (!env.directory.Exists(texturesRoot))
                    env.directory.CreateDirectory(texturesRoot);

                for (int i = 0; i < textures.Count; i++)
                {
                    var tex = textures[i];
                    if (tex == null) continue;

                    string texName = tex.name;
                    texName = Utils.NicifyName(texName);
                    texName = Path.GetFileNameWithoutExtension(texName);

                    var texPath = string.Concat(texturesRoot, texName);

                    texPath = PathUtils.FixDirectorySeparator(texPath);

                    var absolutePath = PathUtils.FixDirectorySeparator($"{Application.dataPath}/../{texPath}");
                    var texturePath = env.assetDatabase.GetAssetPath(tex);

                    if (env.file.Exists(absolutePath))
                    {
                        Texture2D loadedAsset = env.assetDatabase.LoadAssetAtPath<Texture2D>(PathUtils.GetRelativePathTo(Application.dataPath, absolutePath));

                        if (loadedAsset != null)
                        {
                            newTextures.Add(loadedAsset);
                            continue;
                        }
                    }

                    if (!string.IsNullOrEmpty(texturePath))
                    {
                        Texture2D loadedAsset = env.assetDatabase.LoadAssetAtPath<Texture2D>(texturePath);

                        if (loadedAsset != null)
                        {
                            newTextures.Add(loadedAsset);
                            continue;
                        }
                    }

                    // We are always encoding to PNG
                    if (!Path.HasExtension(texPath))
                        texPath += ".png";

                    if (tex.isReadable)
                    {
                        env.file.WriteAllBytes(texPath, tex.EncodeToPNG());
                    }
                    else
                    {
                        RenderTexture tmp = RenderTexture.GetTemporary(
                            tex.width,
                            tex.height,
                            0,
                            RenderTextureFormat.Default,
                            RenderTextureReadWrite.Default);

                        Graphics.Blit(tex, tmp);
                        RenderTexture previous = RenderTexture.active;
                        RenderTexture.active = tmp;
                        Texture2D readableTexture = new Texture2D(tex.width, tex.height);
                        readableTexture.ReadPixels(new Rect(0, 0, tmp.width, tmp.height), 0, 0);
                        readableTexture.Apply();
                        RenderTexture.active = previous;
                        RenderTexture.ReleaseTemporary(tmp);

                        env.file.WriteAllBytes(texPath, readableTexture.EncodeToPNG());

                        tmp.DiscardContents();
                        Object.DestroyImmediate(readableTexture);
                    }

                    env.assetDatabase.ImportAsset(texPath, ImportAssetOptions.ForceSynchronousImport | ImportAssetOptions.ForceUpdate);

                    ReduceTextureSizeIfNeeded(texPath, MAX_TEXTURE_SIZE);

                    newTextures.Add(env.assetDatabase.LoadAssetAtPath<Texture2D>(texPath));
                }
            }

            return newTextures;
        }

        private void OnFinish()
        {

            double conversionTime = EditorApplication.timeSinceStartup - conversionStartupTime;
            double downloadTime = downloadEndTime - downloadStartupTime;
            double nonGltfImportTime = nonGltfImportEndTime - nonGltfImportStartupTime;
            double importTime = importEndTime - importStartupTime;
            double extractTextureTime = embedExtractTextureTime.Elapsed.TotalSeconds;
            double extractMaterialTime = embedExtractMaterialTime.Elapsed.TotalSeconds;
            double configureTime = configureGltftime.Elapsed.TotalSeconds;

            double bundlesTime = bundlesEndTime - bundlesStartupTime;
            double visualTestsTime = visualTestEndTime - visualTestStartupTime;

            var allocated = Profiler.GetTotalAllocatedMemoryLong() / 100000.0;
            var reserved = Profiler.GetTotalReservedMemoryLong() / 100000.0;

            logBuffer = $"Conversion finished!. last error code = {CurrentState.lastErrorCode}";
            logBuffer += "\n";
            logBuffer += $"GLTFs Converted {totalAssets - skippedAssets} of {totalAssets}. (Skipped {skippedAssets})\n";
            logBuffer += $"Total download time: {downloadTime:F} seconds\n";
            logBuffer += $"Total non-gltf import time: {nonGltfImportTime:F} seconds\n";
            logBuffer += $"Total gltf import time: {importTime:F} seconds\n";
            logBuffer += $" - texture extraction time: {extractTextureTime:F} seconds\n";
            logBuffer += $" - material extraction time: {extractMaterialTime:F} seconds\n";
            logBuffer += $" - configure importer time: {configureTime:F} seconds\n";
            logBuffer += $"Total bundle conversion time: {bundlesTime:F} seconds\n";
            logBuffer += "\n";
            logBuffer += $"Total: {conversionTime:F} seconds\n";
            if (totalAssets > 0) { logBuffer += $"Estimated time per asset: {conversionTime / totalAssets:F}\n"; }
            logBuffer += "\n";
            logBuffer += $"Startup Memory | Allocated: {startupAllocated:F} MB Reserved: {startupReserved:F} MB\n";
            logBuffer += $"End Memory | Allocated: {allocated:F} MB Reserved: {reserved:F} MB\n";

            log.Info(logBuffer);

            errorReporter.Dispose();

            if (settings.cleanAndExitOnFinish) { CleanAndExit(CurrentState.lastErrorCode); }
        }

        /// <summary>
        /// Mark all the given assetPaths to be built as asset bundles by Unity's BuildPipeline.
        /// </summary>
        /// <param name="assetPaths">The paths to be built.</param>
        /// <param name="BuildTarget"></param>
        private void MarkAllAssetBundles(List<AssetPath> assetPaths, BuildTarget target)
        {
            foreach (var assetPath in assetPaths)
            {
                if (assetPath == null) continue;

                if (assetPath.finalPath.EndsWith(".bin")) continue;
                string assetBundleName = assetPath.hash + PlatformUtils.GetPlatform();

                env.directory.MarkFolderForAssetBundleBuild(assetPath.finalPath, assetBundleName);
            }
        }

        /// <summary>
        /// Clean all working folders and end the batch process.
        /// </summary>
        /// <param name="errorCode">final errorCode of the conversion process</param>
        public void CleanAndExit(ErrorCodes errorCode)
        {
            foreach (var gltf in gltfToWait)
                gltf.import.Dispose();

            ForceExit((int)errorCode);
        }

        internal void CleanupWorkingFolders()
        {
            env.file.Delete(settings.finalAssetBundlePath + Config.ASSET_BUNDLE_FOLDER_NAME);
            env.file.Delete(settings.finalAssetBundlePath + Config.ASSET_BUNDLE_FOLDER_NAME + ".manifest");

            if (settings.deleteDownloadPathAfterFinished)
            {
                env.directory.Delete(finalDownloadedPath);
                env.assetDatabase.Refresh(ImportAssetOptions.ForceSynchronousImport);
            }
        }

        /// <summary>
        /// Build all marked paths as asset bundles using Unity's BuildPipeline and generate their metadata file (dependencies, version, timestamp)
        /// </summary>
        /// <param name="BuildTarget"></param>
        /// <param name="manifest">AssetBundleManifest generated by the build.</param>
        /// <returns>true is build was successful</returns>
        public virtual bool BuildAssetBundles(BuildTarget target, out IAssetBundleManifest manifest)
        {
            logBuffer = "";

            var abStartTime = EditorApplication.timeSinceStartup;

            env.assetDatabase.Refresh(ImportAssetOptions.ForceSynchronousImport | ImportAssetOptions.ForceUpdate);

            env.assetDatabase.SaveAssets();

            env.assetDatabase.MoveAsset(finalDownloadedPath, Config.DOWNLOADED_PATH_ROOT);

            var afterRefreshTime = EditorApplication.timeSinceStartup;

            // 1. Convert flagged folders to asset bundles only to automatically get dependencies for the metadata
            manifest = env.buildPipeline.BuildAssetBundles(settings.finalAssetBundlePath,
                BuildAssetBundleOptions.UncompressedAssetBundle | BuildAssetBundleOptions.ForceRebuildAssetBundle | BuildAssetBundleOptions.AssetBundleStripUnityVersion,
                target);

            if (manifest == null)
            {
                var message = "Error generating asset bundle!";
                log.Error(message);
                errorReporter.ReportError(message, settings);
                ForceExit((int)ErrorCodes.ASSET_BUNDLE_BUILD_FAIL);
                return false;
            }

            var afterFirstBuild = EditorApplication.timeSinceStartup;

            // 2. Create metadata (dependencies, version, timestamp) and store in the target folders to be converted again later with the metadata inside
            env.assetDatabase.BuildMetadata(env.file, finalDownloadedPath, lowerCaseHashes, manifest, VERSION);

            env.assetDatabase.Refresh(ImportAssetOptions.ForceSynchronousImport | ImportAssetOptions.ForceUpdate);

            env.assetDatabase.SaveAssets();

            var afterSecondRefresh = EditorApplication.timeSinceStartup;

            // 3. Convert flagged folders to asset bundles again but this time they have the metadata file inside
            manifest = env.buildPipeline.BuildAssetBundles(settings.finalAssetBundlePath,
                BuildAssetBundleOptions.UncompressedAssetBundle | BuildAssetBundleOptions.ForceRebuildAssetBundle | BuildAssetBundleOptions.AssetBundleStripUnityVersion,
                target);

            var afterSecondBuild = EditorApplication.timeSinceStartup;

            logBuffer += $"Step 0: {afterRefreshTime - abStartTime}\n";
            logBuffer += $"Step 1: {afterFirstBuild - afterRefreshTime}\n";
            logBuffer += $"Step 2: {afterSecondRefresh - afterFirstBuild}\n";
            logBuffer += $"Step 3: {afterSecondBuild - afterSecondRefresh}\n";

            logBuffer += $"Generating asset bundles at path: {settings.finalAssetBundlePath}\n";

            string[] assetBundles = manifest.GetAllAssetBundles();

            logBuffer += $"Total generated asset bundles: {assetBundles.Length}\n";

            for (int i = 0; i < assetBundles.Length; i++)
            {
                if (string.IsNullOrEmpty(assetBundles[i]))
                    continue;

                logBuffer += $"#{i} Generated asset bundle name: {assetBundles[i]}\n";
            }

            logBuffer += $"\nFree disk space after conv: {PathUtils.GetFreeSpace()}";

            log.Verbose(logBuffer);

            return true;
        }

        private void CleanAssetBundleFolder(string[] assetBundles)
        {
            env.directory.CleanAssetBundleFolder(env.file, settings.finalAssetBundlePath, assetBundles, lowerCaseHashes);
        }

        private void InitializeDirectoryPaths(bool deleteDownloadDirIfExists, bool deleteABsDireIfExists)
        {
            log.Info("Initializing directory -- " + finalDownloadedPath);
            env.directory.InitializeDirectory(finalDownloadedPath, deleteDownloadDirIfExists);
            log.Info("Initializing directory -- " + settings.finalAssetBundlePath);
            env.directory.InitializeDirectory(settings.finalAssetBundlePath, deleteABsDireIfExists);
        }

        private void PopulateLowercaseMappings(IReadOnlyList<ContentServerUtils.MappingPair> pairs)
        {
            foreach (var content in pairs)
            {
                string hashLower = content.hash.ToLowerInvariant();
                lowerCaseHashes.TryAdd(hashLower, content.hash);
            }
        }

        /// <summary>
        /// Download all assets and tag them for asset bundle building.
        /// </summary>
        /// <param name="rawContents">An array containing all the assets to be dumped.</param>
        /// <returns>true if succeeded</returns>
        ///

        private async Task<bool> DownloadAssets(IReadOnlyList<ContentServerUtils.MappingPair> rawContents)
        {
            try
            {
                if (settings.verbose)
                    Debug.Log(string.Join("\n", rawContents.Select(r => $"{r.hash} -> {r.file}")));

                List<AssetPath> gltfPaths = Utils.GetPathsFromPairs(finalDownloadedPath, rawContents, Config.gltfExtensions);
                List<AssetPath> bufferPaths = Utils.GetPathsFromPairs(finalDownloadedPath, rawContents, Config.bufferExtensions);
                List<AssetPath> texturePaths = Utils.GetPathsFromPairs(finalDownloadedPath, rawContents, Config.textureExtensions);

                if (!FilterDumpList(ref gltfPaths))
                    return false;

                List<Task> downloadTasks = new List<Task>();
                downloadTasks.AddRange(gltfPaths.Select(CreateDownloadTask));
                downloadTasks.AddRange(bufferPaths.Select(CreateDownloadTask));
                downloadTasks.AddRange(texturePaths.Select(CreateDownloadTask));

                downloadStartupTime = EditorApplication.timeSinceStartup;

                if (settings.clearDirectoriesOnStart)
                    foreach (Task downloadTask in downloadTasks)
                        await downloadTask;

                downloadEndTime = EditorApplication.timeSinceStartup;

                nonGltfImportStartupTime = EditorApplication.timeSinceStartup;

                //NOTE(Brian): Prepare textures and buffers. We should prepare all the dependencies in this phase.
                assetsToMark.AddRange(ImportTextures(texturePaths));
                assetsToMark.AddRange(ImportBuffers(bufferPaths));

                AddAssetPathsToContentTable(texturePaths);
                AddAssetPathsToContentTable(bufferPaths);
                AddAssetPathsToContentTable(gltfPaths, true);

                totalGltfsToProcess = gltfPaths.Count;

                foreach (var gltfPath in gltfPaths)
                {
                    if (isExitForced) break;

                    if (!string.IsNullOrEmpty(settings.importOnlyEntity))
                        if (!string.Equals(gltfPath.hash, settings.importOnlyEntity, StringComparison.CurrentCultureIgnoreCase))
                            continue;

                    assetsToMark.Add(ImportGltf(gltfPath));
                }

                nonGltfImportEndTime = EditorApplication.timeSinceStartup;
            }
            catch (Exception e)
            {
                Debug.LogException(e);
                errorReporter.ReportException(new ConversionException(ConversionStep.Fetch, settings, e));
                ForceExit((int)ErrorCodes.DOWNLOAD_FAILED);
                return false;
            }

            downloadedData.Clear();
            downloadedData = null;

            return true;
        }

        private async Task RecursiveDownload(Task downloadTask, int tryCount, int maxTries)
        {
            if (tryCount >= maxTries)
            {
                var message = $"Download Failed by max retry count exceeded, probably a connection error";
                log.Error(message);
                errorReporter.ReportError(message, settings);
                ForceExit((int)ErrorCodes.DOWNLOAD_FAILED);
                throw new OperationCanceledException();
            }

            try
            {
                await downloadTask;
            }
            catch (Exception e)
            {
                Debug.LogException(e);
                await Task.Delay(TimeSpan.FromSeconds(1));
                await RecursiveDownload(downloadTask, tryCount+1, maxTries);
            }
        }

        public async Task CreateDownloadTask(AssetPath assetPath)
        {
            DownloadHandler downloadHandler = null;
            string url = settings.baseUrl + assetPath.hash;

            try
            {
                downloadHandler = await env.webRequest.Get(url);

                if (downloadHandler == null)
                {
                    var message = $"Download Failed {url} -- null DownloadHandler?";
                    log.Error(message);
                    errorReporter.ReportError(message, settings);
                    return;
                }
            }
            catch (Exception e)
            {
                var message = $"Download Failed {url} -- {e.Message}";
                log.Error(message);
                errorReporter.ReportError(message, settings);
                ForceExit((int)ErrorCodes.DOWNLOAD_FAILED);
                return;
            }

            //       the file bafkreihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku is a valid content
            //       file of zero bytes, which returns downloadHandler.data==null. and it should be `new Byte[] {}`
            byte[] downloadHandlerData = downloadHandler.data ?? Array.Empty<byte>();
            downloadHandler.Dispose();
            downloadedData.Add(assetPath, downloadHandlerData);
        }

        private void AddAssetPathsToContentTable(List<AssetPath> assetPaths, bool useHash = false)
        {
            foreach (AssetPath assetPath in assetPaths)
            {
                var relativeFinalPath = "Assets" + assetPath.finalPath.Substring(Application.dataPath.Length);

                // since GLTF's are already renamed as their hash, we have to map them using their hash so the GltFastFileProvider can get them properly
                string finalKey = useHash ? Utils.EnsureStartWithSlash(assetPath.hashPath) : Utils.EnsureStartWithSlash(assetPath.filePath);
                finalKey = finalKey.ToLower();
                contentTable[finalKey] = relativeFinalPath;
            }
        }

        /// <summary>
        /// Trims off existing asset bundles from the given AssetPath array,
        /// if none exists and shouldAbortBecauseAllBundlesExist is true, it will return false.
        /// </summary>
        /// <param name="gltfPaths">paths to be checked for existence</param>
        /// <returns>false if all paths are already converted to asset bundles, true if the conversion makes sense</returns>
        internal bool FilterDumpList(ref List<AssetPath> gltfPaths)
        {
            bool shouldBuildAssetBundles;

            totalAssets = gltfPaths.Count;

            if (settings.skipAlreadyBuiltBundles)
            {
                int gltfCount = gltfPaths.Count;

                gltfPaths = gltfPaths.Where(
                                          assetPath =>
                                              !env.file.Exists(settings.finalAssetBundlePath + assetPath.hash))
                                     .ToList();

                int skippedCount = gltfCount - gltfPaths.Count;
                skippedAssets = skippedCount;
                shouldBuildAssetBundles = gltfPaths.Count == 0;
            }
            else { shouldBuildAssetBundles = false; }

            if (shouldBuildAssetBundles)
            {
                log.Info("All assets in this scene were already generated!. Skipping.");

                return false;
            }

            return true;
        }

        /// <summary>
        /// This will download all assets contained in the AssetPath list using the baseUrl + hash.
        ///
        /// After the assets are downloaded, they will be imported using Unity's AssetDatabase and
        /// their guids will be normalized using the asset's cid.
        ///
        /// The guid normalization will ensure the guids remain consistent and the same asset will
        /// always have the asset guid. If we don't normalize the guids, Unity will chose a random one,
        /// and this can break the Asset Bundles dependencies as they are resolved by guid.
        /// </summary>
        /// <param name="assetPaths">List of assetPaths to be dumped</param>
        /// <returns>A list with assetPaths that were successfully dumped. This list will be empty if all dumps failed.</returns>
        internal List<AssetPath> ImportTextures(List<AssetPath> assetPaths)
        {
            List<AssetPath> result = new List<AssetPath>(assetPaths);

            for (var i = 0; i < assetPaths.Count; i++)
            {
                if (isExitForced) break;

                env.editor.DisplayProgressBar("Asset Bundle Converter", "Downloading Importable Assets", i / (float)assetPaths.Count);

                var assetPath = assetPaths[i];

                if (env.file.Exists(assetPath.finalPath))
                    continue;

                //NOTE(Brian): try to get an AB before getting the original texture, so we bind the dependencies correctly
                string fullPathToTag = GetDownloadedAsset(assetPath);

                if (fullPathToTag == null)
                {
                    result.Remove(assetPath);
                    log.Error("Failed to get texture dependencies! failing asset: " + assetPath.hash);

                    continue;
                }

                var importer = env.assetDatabase.GetImporterAtPath(assetPath.finalPath);

                if (importer is TextureImporter texImporter)
                {
                    string finalTexturePath = finalDownloadedPath + assetPath.hash + "/" + assetPath.hash + Path.GetExtension(assetPath.filePath);
                    ReduceTextureSizeIfNeeded(finalTexturePath, MAX_TEXTURE_SIZE);

                    texImporter.crunchedCompression = true;
                    texImporter.textureCompression = TextureImporterCompression.CompressedHQ;
                    texImporter.isReadable = true;
                    texImporter.alphaIsTransparency = true;
                    EditorUtility.SetDirty(texImporter);
                }

                env.assetDatabase.ImportAsset(assetPath.finalPath, ImportAssetOptions.ForceUpdate);

                SetDeterministicAssetDatabaseGuid(assetPath);

                log.Verbose($"Downloaded asset = {assetPath.filePath} to {assetPath.finalPath}");
            }

            env.editor.ClearProgressBar();

            return result;
        }

        /// <summary>
        /// in asset bundles, all dependencies are resolved by their guid (and not the AB hash nor CRC)
        /// So to ensure dependencies are being kept in subsequent editor runs we normalize the asset guid using
        /// the CID.
        ///
        /// This method:
        /// - Looks for the meta file of the given assetPath.
        /// - Changes the .meta guid using the assetPath's cid as seed.
        /// - Does some file system gymnastics to make sure the new guid is imported to our AssetDatabase.
        /// </summary>
        /// <param name="assetPath">AssetPath of the target asset to modify</param>
        private void SetDeterministicAssetDatabaseGuid(AssetPath assetPath)
        {
            string metaPath = env.assetDatabase.GetTextMetaFilePathFromAssetPath(assetPath.finalPath);

            env.assetDatabase.ReleaseCachedFileHandles();

            string metaContent = env.file.ReadAllText(metaPath);
            string guid = Utils.CidToGuid(assetPath.hash);
            string newMetaContent = Regex.Replace(metaContent, @"guid: \w+?\n", $"guid: {guid}\n");

            //NOTE(Brian): We must do this hack in order to the new guid to be added to the AssetDatabase.
            //             on windows, an AssetImporter.SaveAndReimport call makes the trick, but this won't work
            //             on Unix based OSes for some reason.
            env.file.Delete(metaPath);

            env.file.Copy(assetPath.finalPath, finalDownloadedPath + "tmp");
            env.assetDatabase.DeleteAsset(assetPath.finalPath);
            env.file.Delete(assetPath.finalPath);

            env.assetDatabase.Refresh();
            env.assetDatabase.SaveAssets();

            env.file.Copy(finalDownloadedPath + "tmp", assetPath.finalPath);
            env.file.WriteAllText(metaPath, newMetaContent);
            env.file.Delete(finalDownloadedPath + "tmp");
            env.file.Delete(finalDownloadedPath + "tmp.meta");

            env.assetDatabase.Refresh();
            env.assetDatabase.SaveAssets();
        }

        /// <summary>
        /// This will download a single asset referenced by an AssetPath.
        /// The download target is baseUrl + hash.
        /// </summary>
        /// <param name="assetPath">The AssetPath object referencing the asset to be downloaded</param>
        /// <param name="isGltf"></param>
        /// <returns>The file output path. Null if download failed.</returns>
        internal string GetDownloadedAsset(AssetPath assetPath, bool isGltf = false)
        {
            string outputPath = assetPath.finalPath;
            string outputPathDir = Path.GetDirectoryName(outputPath);

            void FinallyImportAsset()
            {
                if (isGltf)
                {
                    IGltfImport gltfImport = CreateGltfImport(assetPath);

                    gltfToWait.Add(new GltfImportSettings
                    {
                        AssetPath = assetPath, url = outputPath, import = gltfImport
                    });

                    gltfOriginalNames[outputPath] = assetPath.filePath;
                }
                else { env.assetDatabase.ImportAsset(outputPath, ImportAssetOptions.ForceUpdate); }
            }

            if (env.file.Exists(outputPath))
            {
                FinallyImportAsset();

                return outputPath;
            }

            if (!env.directory.Exists(outputPathDir))
                env.directory.CreateDirectory(outputPathDir);

            byte[] data = downloadedData[assetPath];
            env.file.WriteAllBytes(outputPath, data);

            FinallyImportAsset();

            return outputPath;
        }

        private IGltfImport CreateGltfImport(AssetPath filePath) =>
            env.gltfImporter.GetImporter(filePath, contentTable, settings.shaderType, settings.buildTarget);

        private void ReduceTextureSizeIfNeeded(string texturePath, float maxSize)
        {
            byte[] image = env.file.ReadAllBytes(texturePath);

            var tmpTex = new Texture2D(1, 1);

            if (!tmpTex.LoadImage(image))
            {
                Object.DestroyImmediate(tmpTex);
                return;
            }

            float factor;
            int width = tmpTex.width;
            int height = tmpTex.height;

            float maxTextureSize = maxSize;

            if (width <= maxTextureSize && height <= maxTextureSize)
                return;

            if (width >= height)
                factor = maxTextureSize / width;
            else
                factor = maxTextureSize / height;

            Texture2D dstTex = Utils.ResizeTexture(tmpTex, (int)(width * factor), (int)(height * factor));
            byte[] endTex = dstTex.EncodeToPNG();
            Object.DestroyImmediate(tmpTex);

            env.file.WriteAllBytes(texturePath, endTex);
        }

        /// <summary>
        /// Download assets and put them in the working folder.
        /// </summary>
        /// <param name="bufferPaths">AssetPath list containing all the desired paths to be downloaded</param>
        /// <returns>List of the successfully downloaded assets.</returns>
        internal List<AssetPath> ImportBuffers(List<AssetPath> bufferPaths)
        {
            List<AssetPath> result = new List<AssetPath>(bufferPaths);

            if (bufferPaths.Count == 0 || bufferPaths == null)
                return result;

            for (var i = 0; i < bufferPaths.Count; i++)
            {
                if (isExitForced) break;

                env.editor.DisplayProgressBar("Asset Bundle Converter", "Downloading Raw Assets",
                    i / (float)bufferPaths.Count);

                var assetPath = bufferPaths[i];

                if (env.file.Exists(assetPath.finalPath))
                    continue;

                var finalDlPath = GetDownloadedAsset(assetPath);

                if (string.IsNullOrEmpty(finalDlPath))
                    result.Remove(assetPath);
            }

            env.editor.ClearProgressBar();

            return result;
        }

        /// <summary>
        /// Download a single gltf asset injecting the proper external references
        /// </summary>
        /// <param name="gltfPath">GLTF to be downloaded</param>
        /// <returns>gltf AssetPath if dump succeeded, null if don't</returns>
        internal AssetPath ImportGltf(AssetPath gltfPath)
        {
            string path = GetDownloadedAsset(gltfPath, true);

            return path != null ? gltfPath : null;
        }

        private void ForceExit(int errorCode = 0)
        {
            isExitForced = true;
            env.editor.Exit(errorCode);
        }
    }
}
