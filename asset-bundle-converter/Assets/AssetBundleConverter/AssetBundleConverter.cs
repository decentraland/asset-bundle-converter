using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Text.RegularExpressions;
using System.Threading.Tasks;
using AssetBundleConverter;
using AssetBundleConverter.Editor;
using AssetBundleConverter.StaticSceneAssetBundle;
using AssetBundleConverter.Wrappers.Interfaces;
using Cysharp.Threading.Tasks;
using GLTFast;
using Newtonsoft.Json;
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
            public ContentServerUtils.EntityMappingsDTO apiResponse;
        }

        private struct GltfImportSettings
        {
            public string url;
            public IGltfImport import;
            public AssetPath AssetPath;
        }

        private const float DEFAULT_MAX_TEXTURE_SIZE = 512f;
        private const float DESKTOP_MAX_TEXTURE_SIZE = 1024f;

        private const string VERSION = "7.0";
        private const string LOOP_PARAMETER = "Loop";

        private readonly Dictionary<string, string> lowerCaseHashes = new ();
        public ConversionState CurrentState { get; } = new ();
        private Environment env;
        private ClientSettings settings;
        private readonly string finalDownloadedPath;
        private readonly string finalDownloadedAssetDbPath;
        private List<AssetPath> assetsToMark = new ();
        private List<GltfImportSettings> gltfToWait = new ();
        private Dictionary<string, string> contentTable = new ();
        private Dictionary<string, string> gltfOriginalNames = new ();
        private Dictionary<string, IGltfImport> gltfImporters = new ();
        private string logBuffer;
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

        /// <summary>
        /// Total number of GLTFs required by the conversion process
        /// </summary>
        private int totalGltfs;

        /// <summary>
        /// Total number of missing GLTFs
        /// </summary>
        private int totalGltfsToProcess;

        /// <summary>
        /// Total number of successfully processed GLTFs
        /// </summary>
        private int totalGltfsProcessed;

        private bool isExitForced = false;
        private IABLogger log => env.logger;
        private Dictionary<AssetPath, byte[]> downloadedData = new();
        private ContentServerUtils.EntityMappingsDTO entityDTO;
        private readonly Dictionary<Shader, List<int>> textureProperties = new ();

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
            entityDTO = conversionParams.apiResponse;
            startupAllocated = Profiler.GetTotalAllocatedMemoryLong() / 100000.0;
            startupReserved = Profiler.GetTotalReservedMemoryLong() / 100000.0;



            if (settings.buildTarget is not (BuildTarget.WebGL or BuildTarget.StandaloneWindows64 or BuildTarget.StandaloneOSX))
            {
                var message = $"Build target is invalid: {settings.buildTarget.ToString()}";
                log.Error(message);
                errorReporter.ReportError(message, settings);
                ForceExit(ErrorCodes.INVALID_PLATFORM);
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
                if (!await ResolveAssets(rawContents))
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

            await ProcessAllGltfs();

            importEndTime = EditorApplication.timeSinceStartup;

            EditorUtility.ClearProgressBar();

            if (TryExitWithGltfErrors())
                return;

            if (settings.createAssetBundle)
            {
                GC.Collect();

                bundlesStartupTime = EditorApplication.timeSinceStartup;

                MarkAndBuildForTarget(settings.buildTarget, settings.json);

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

        private bool TryExitWithGltfErrors()
        {
            var failedAssets = totalGltfsToProcess - totalGltfsProcessed;
            var toleratedCount = Mathf.RoundToInt(settings.failingConversionTolerance * totalGltfs);

            // Try tolerate errors
            if (failedAssets <= toleratedCount)
            {
                log.Warning($"Failed to convert {failedAssets} assets, but tolerating up to {toleratedCount} errors");

                if (failedAssets > 0)
                    CurrentState.lastErrorCode = ErrorCodes.CONVERSION_ERRORS_TOLERATED;

                return false;
            }


            var message = $"GLTF count mismatch GLTF to process: {totalGltfsToProcess} vs GLTF processed: {totalGltfsProcessed}";
            log.Error(message);
            errorReporter.ReportError(message, settings);
            ForceExit(ErrorCodes.GLTF_PROCESS_MISMATCH);
            return true;
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

        private void MarkAndBuildForTarget(BuildTarget target, string staticSceneJSON)
        {

            // Fourth step: we mark all assets for bundling
            MarkAllAssetBundles(assetsToMark, target, staticSceneJSON);

            // Fifth step: we build the Asset Bundles
            env.assetDatabase.Refresh();
            env.assetDatabase.SaveAssets();
            CurrentState.step = ConversionState.Step.BUILDING_ASSET_BUNDLES;

            if (BuildAssetBundles(target, out var manifest))
            {
                CleanAssetBundleFolder(manifest.GetAllAssetBundles());

                CurrentState.lastErrorCode = ErrorCodes.SUCCESS;
                CurrentState.step = ConversionState.Step.FINISHED;
            }
            else
            {
                CurrentState.lastErrorCode = ErrorCodes.ASSET_BUNDLE_BUILD_FAIL;
                CurrentState.step = ConversionState.Step.FINISHED;
            }
        }

        /// <summary>
        /// During this step we import gltfs into the scene and then we import the gltf so it can be marked for AB conversion
        /// </summary>
        /// <returns></returns>
        private Stopwatch embedExtractTextureTime;
        private Stopwatch embedExtractMaterialTime;
        private Stopwatch configureGltftime;

        /// <summary>
        /// Does not force exit
        /// </summary>
        private async Task ProcessAllGltfs()
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

            foreach (GltfImportSettings gltf in gltfToWait)
            {
                string gltfUrl = gltf.url;
                var gltfImport = gltf.import;
                string relativePath = PathUtils.FullPathToAssetPath(gltfUrl);
                bool isEmote = (entityDTO is { type: not null } && entityDTO.type.ToLower().Contains("emote"))
                               || gltf.AssetPath.fileName.ToLower().EndsWith("_emote.glb");

                AnimationMethod animationMethod = GetAnimationMethod(isEmote);

                var importSettings = new ImportSettings
                {
                    AnimationMethod = animationMethod,
                    NodeNameMethod = NameImportMethod.OriginalUnique,
                    AnisotropicFilterLevel = 0,
                    GenerateMipMaps = false
                };

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
                        var message = $"GLTF is invalid or contains errors: {gltfUrl}, {gltfImport.LastErrorCode}";
                        log.Error(message);
                        errorReporter.ReportError(message, settings);
                        continue;
                    }

                    var textures = new List<Texture2D>();

                    for (int i = 0; i < gltfImport.TextureCount; i++)
                        textures.Add(gltfImport.GetTexture(i));

                    embedExtractTextureTime.Start();

                    string directory = Path.GetDirectoryName(relativePath);

                    if (textures.Count > 0) { textures = ExtractEmbedTexturesFromGltf(textures, gltfImport, directory); }

                    embedExtractTextureTime.Stop();

                    embedExtractMaterialTime.Start();
                    ExtractEmbedMaterialsFromGltf(textures, gltf, gltfImport, gltfUrl);
                    embedExtractMaterialTime.Stop();

                    if (animationMethod == AnimationMethod.Mecanim)
                    {
                        if (isEmote)
                            CreateAnimatorController(gltfImport, directory);
                        else
                            CreateLayeredAnimatorController(gltfImport, directory);
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
                            SetExitState(ErrorCodes.GLTFAST_CRITICAL_ERROR);
                            continue;
                        }
                    }
                    else
                    {
                        var message = $"Failed to get the gltf importer for {gltfUrl} \nPath: {relativePath}";
                        log.Error(message);
                        errorReporter.ReportError(message, settings);
                        SetExitState(ErrorCodes.GLTF_IMPORTER_NOT_FOUND);
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

                catch (FileLoadException)
                {
                    Debug.LogError($"<b>{gltf.AssetPath.fileName} ({gltf.AssetPath.hash})</b> Failed to load since its empty, we will replace this with an empty game object");
                    GameObject replacement = new GameObject(gltf.AssetPath.hash);
                    env.assetDatabase.DeleteAsset(relativePath);
                    string prefabPath = Path.ChangeExtension(relativePath, ".prefab");
                    PrefabUtility.SaveAsPrefabAsset(replacement, prefabPath);
                    // it's not an error so we don't skip the iteration
                }
                catch (Exception e)
                {
                    log.Error("UNCAUGHT FATAL: Failed to load GLTF " + gltf.AssetPath.hash);
                    Debug.LogException(e);
                    errorReporter.ReportException(new ConversionException(ConversionStep.Import, settings, e));
                    SetExitState(ErrorCodes.GLTFAST_CRITICAL_ERROR);
                    continue;
                }
                finally
                {
                    await Resources.UnloadUnusedAssets();
                }

                totalGltfsProcessed++;
            }

            EditorUtility.ClearProgressBar();

            log.Info("Ended importing GLTFs");
        }

        private void CreateLayeredAnimatorController(IGltfImport gltfImport, string directory)
        {
            var clips = gltfImport.GetClips();
            if (clips == null) return;

            var animatorRoot = $"{directory}/Animator/";

            if (!env.directory.Exists(animatorRoot))
                env.directory.CreateDirectory(animatorRoot);

            var filePath = $"{animatorRoot}animatorController.controller";
            var controller = AnimatorController.CreateAnimatorControllerAtPath(filePath);

            List<string> layerNames = new List<string>();
            foreach (AnimatorControllerLayer animatorControllerLayer in controller.layers)
                layerNames.Add(animatorControllerLayer.name);

            for (var i = 0; i < clips.Count; i++)
            {
                AnimationClip originalClip = clips[i];

                // copy the animation asset so we dont use the same references that will get disposed
                var clip = Object.Instantiate(originalClip);
                clip.name = originalClip.name;

                // embed clip into the animatorController
                AssetDatabase.AddObjectToAsset(clip, controller);
                AssetDatabase.ImportAsset(AssetDatabase.GetAssetPath(clip));

                // We consider the first state as default state so it results in the same behaviour as 'play automatically' from the old Animation component
                bool isDefaultState = i == 0;
                string animationClipName = clip.name;

                // Configure parameters
                var triggerParameterName = $"{animationClipName}_Trigger";
                var loopParameterName = $"{animationClipName}_{LOOP_PARAMETER}";
                var enabledParameterName = $"{animationClipName}_Enabled";

                controller.AddParameter(triggerParameterName, AnimatorControllerParameterType.Trigger);

                controller.AddParameter(new AnimatorControllerParameter
                {
                    name = loopParameterName,
                    type = AnimatorControllerParameterType.Bool,
                    defaultBool = originalClip.wrapMode == WrapMode.Loop,
                });

                controller.AddParameter(new AnimatorControllerParameter
                {
                    name = enabledParameterName,
                    type = AnimatorControllerParameterType.Bool,
                    defaultBool = isDefaultState,
                });

                // Configure layers
                string layerName = controller.MakeUniqueLayerName(animationClipName);
                layerNames.Add(layerName);
                controller.AddLayer(new AnimatorControllerLayer
                {
                    name = layerName,
                    defaultWeight = isDefaultState ? 1f : 0f,
                    stateMachine = new AnimatorStateMachine(),
                    iKPass = false,
                    blendingMode = AnimatorLayerBlendingMode.Override,
                    avatarMask = null,
                });
                int layerIndex = GetLayerIndex();
                AnimatorControllerLayer layer = controller.layers[layerIndex];
                AnimatorStateMachine layerStateMachine = layer.stateMachine;

                AssetDatabase.AddObjectToAsset(layerStateMachine, controller);

                // Configure states
                var empty = layerStateMachine.AddState("Empty");
                // The current animation system expects the clips to stay on its current frame when the execution stops
                empty.writeDefaultValues = false;
                var state = controller.AddMotion(clip, layerIndex);

                layerStateMachine.defaultState = isDefaultState ? state : empty;

                // Configure transitions
                // TODO: should we add a small duration? it would make smoother transitions
                // Empty
                {
                    AnimatorStateTransition fromAnyStateTransition = layerStateMachine.AddAnyStateTransition(empty);
                    fromAnyStateTransition.AddCondition(AnimatorConditionMode.IfNot, 0, enabledParameterName);
                    fromAnyStateTransition.duration = 0;
                }

                // Clip
                {
                    AnimatorStateTransition fromAnyStateTransition = layerStateMachine.AddAnyStateTransition(state);
                    fromAnyStateTransition.AddCondition(AnimatorConditionMode.If, 0, triggerParameterName);
                    fromAnyStateTransition.duration = 0;
                    fromAnyStateTransition.canTransitionToSelf = false;

                    AnimatorStateTransition loopTransition = state.AddTransition(state);
                    loopTransition.AddCondition(AnimatorConditionMode.If, 0, loopParameterName);
                    loopTransition.exitTime = 1;
                    loopTransition.duration = 0;
                    loopTransition.hasExitTime = true;
                    loopTransition.canTransitionToSelf = true;

                    AnimatorStateTransition toEmptyTransition = state.AddTransition(empty);
                    toEmptyTransition.AddCondition(AnimatorConditionMode.IfNot, 0, loopParameterName);
                    toEmptyTransition.exitTime = 1;
                    toEmptyTransition.duration = 0;
                    toEmptyTransition.hasExitTime = true;
                }

                continue;

                int GetLayerIndex()
                {
                    for (var i = 0; i < layerNames.Count; i++)
                        if (layerNames[i] == layerName)
                            return i;

                    return -1;
                }
            }

            AssetDatabase.SaveAssets();
            AssetDatabase.Refresh();
        }

        private void CreateAnimatorController(IGltfImport gltfImport, string directory)
        {
            var clips = gltfImport.GetClips();
            if (clips == null) return;

            var animatorRoot = $"{directory}/Animator/";

            if (!env.directory.Exists(animatorRoot))
                env.directory.CreateDirectory(animatorRoot);

            var filePath = $"{animatorRoot}animatorController.controller";
            var controller = AnimatorController.CreateAnimatorControllerAtPath(filePath);
            var rootStateMachine = controller.layers[0].stateMachine;

            controller.AddParameter(new AnimatorControllerParameter
            {
                name = LOOP_PARAMETER,
                type = AnimatorControllerParameterType.Bool,
                // All clips are imported as wrapMode=Loop
                defaultBool = true,
            });

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

                var stateLoop = controller.AddMotion(newCopy, 0);

                var loopTransition = state.AddTransition(stateLoop);
                loopTransition.AddCondition(AnimatorConditionMode.If, 0, LOOP_PARAMETER);
                loopTransition.exitTime = 1;
                loopTransition.duration = 0;
                loopTransition.hasExitTime = true;

                var loopBackTransition = stateLoop.AddTransition(state);
                loopBackTransition.AddCondition(AnimatorConditionMode.If, 0, LOOP_PARAMETER);
                loopBackTransition.exitTime = 1;
                loopBackTransition.duration = 0;
                loopBackTransition.hasExitTime = true;
            }

            AssetDatabase.SaveAssets();
            AssetDatabase.Refresh();
        }

        private AnimationMethod GetAnimationMethod(bool isEmote)
        {
            if (entityDTO == null) return AnimationMethod.Legacy;
            if (isEmote) return AnimationMethod.Mecanim;
            if (settings.buildTarget is BuildTarget.StandaloneWindows64 or BuildTarget.StandaloneOSX)
                return settings.AnimationMethod;

            //WebGL platform fallback is always Legacy
            return AnimationMethod.Legacy;
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
                CreateMaterialAsset(mat, materialDirectory, texNameMap, gltf.AssetPath.hash);
            }

            for (var t = 0; t < gltfImport.MaterialCount; t++)
            {
                var originalMaterial = gltfImport.GetMaterial(t);
                CreateMaterialAsset(originalMaterial, materialDirectory, texNameMap, gltf.AssetPath.hash);
            }

            Profiler.EndSample();
            log.Verbose($"gltf creating dummy materials completed: {gltfUrl}");
            RefreshAssetsWithNoLogs();
        }

        private void CreateMaterialAsset(Material originalMaterial, string materialRoot, Dictionary<string, Texture2D> texNameMap, string hash)
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



        private List<Texture2D> ExtractEmbedTexturesFromGltf(List<Texture2D> textures, IGltfImport gltfImport, string folderName)
        {
            var newTextures = new List<Texture2D>();

            TextureTypeManager textTypeMan = new TextureTypeManager();

            for (var t = 0; t < gltfImport.MaterialCount; t++)
            {

                var originalMaterial = gltfImport.GetMaterial(t);
                var textureProperties = originalMaterial.GetTexturePropertyNameIDs();
                var texturePropertiesNames = originalMaterial.GetTexturePropertyNames();

                for (int i = 0; i < textureProperties.Count(); i++)
                {
                    int propertyId = textureProperties[i];
                    Texture currentTexture = originalMaterial.GetTexture(propertyId);
                    if (currentTexture)
                        textTypeMan.AddTextureType(currentTexture.name, TextureInfoExtensions.GetTextureTypeFromString(texturePropertiesNames[i]));
                }
            }

            if (textures.Count > 0)
            {
                var texturesRoot = $"{folderName}/Textures/";

                if (!env.directory.Exists(texturesRoot))
                    env.directory.CreateDirectory(texturesRoot);

                float maxTextureSize = settings.buildTarget is BuildTarget.StandaloneWindows64 or BuildTarget.StandaloneOSX
                    ? DESKTOP_MAX_TEXTURE_SIZE
                    : DEFAULT_MAX_TEXTURE_SIZE;

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

                    if (tex.isReadable && !TextureUtils.IsCompressedFormat(tex.format))
                    {
                        env.file.WriteAllBytes(texPath, tex.EncodeToPNG());
                    }
                    else
                    {
                        TextureInfo texInfo = textTypeMan.GetTextureInfo(tex.name);

                        RenderTexture tmp = RenderTexture.GetTemporary(
                            tex.width,
                            tex.height,
                            0,
                            texInfo.HasAnyType(TextureType.BumpMap) && !texInfo.HasAnyType(TextureType.MainTex | TextureType.BaseMap) ? RenderTextureFormat.RGHalf : RenderTextureFormat.Default,
                            texInfo.HasAnyType( TextureType.BumpMap | TextureType.MetallicGlossMap | TextureType.OcclusionMap | TextureType.ParallaxMap | TextureType.SpecGlossMap) ? RenderTextureReadWrite.Linear : RenderTextureReadWrite.Default );

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

                    ReduceTextureSizeIfNeeded(texPath, maxTextureSize);

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
            logBuffer += $"GLTFs Converted {totalGltfs - skippedAssets} of {totalGltfs}. (Skipped {skippedAssets})\n";
            logBuffer += $"Total download time: {downloadTime:F} seconds\n";
            logBuffer += $"Total non-gltf import time: {nonGltfImportTime:F} seconds\n";
            logBuffer += $"Total gltf import time: {importTime:F} seconds\n";
            logBuffer += $" - texture extraction time: {extractTextureTime:F} seconds\n";
            logBuffer += $" - material extraction time: {extractMaterialTime:F} seconds\n";
            logBuffer += $" - configure importer time: {configureTime:F} seconds\n";
            logBuffer += $"Total bundle conversion time: {bundlesTime:F} seconds\n";
            logBuffer += "\n";
            logBuffer += $"Total: {conversionTime:F} seconds\n";
            if (totalGltfs > 0) { logBuffer += $"Estimated time per asset: {conversionTime / totalGltfs:F}\n"; }
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
        private void MarkAllAssetBundles(List<AssetPath> assetPaths, BuildTarget target, string staticSceneJSON)
        {
            var asset = ScriptableObject.CreateInstance<StaticSceneDescriptor>();

            Dictionary<string, List<int>> gltfsComponents = new Dictionary<string, List<int>>();
            List<string> textureComponents = new List<string>();


            if (!string.IsNullOrEmpty(staticSceneJSON))
            {
                try
                {
                    var components = Newtonsoft.Json.JsonConvert.DeserializeObject<dynamic[]>(staticSceneJSON);
                    foreach (var component in components)
                    {
                        if (component.componentName == "core::GltfContainer" && component.data?.src != null)
                        {
                            string src = component.data.src;
                            if(!gltfsComponents.ContainsKey(src))
                                gltfsComponents.Add(src, new List<int>());

                            gltfsComponents[src].Add((int)component.entityId);
                        }else if (component.componentName == "core::Material" && component.data?.material?.unlit?.texture?.tex?.texture?.src != null)
                        {
                            string src = component.data?.material?.unlit?.texture?.tex?.texture?.src;
                            textureComponents.Add(src);
                        }
                        else if (component.componentName == "core::Material" && component.data?.material?.pbr?.texture?.tex?.texture?.src != null)
                        {
                            string src = component.data?.material?.pbr?.texture?.tex?.texture?.src;
                            textureComponents.Add(src);
                        }
                    }
                }
                catch (Exception e)
                {
                    log.Warning($"Failed to parse staticSceneJSON: {e.Message}");
                }
            }

            foreach (var assetPath in assetPaths)
            {
                if (assetPath == null) continue;

                if (assetPath.finalPath.EndsWith(".bin")) continue;

                // Check if this asset matches a GltfContainer source
                bool isStatic = gltfsComponents.ContainsKey(assetPath.filePath);
                string assetBundleName = assetPath.hash + PlatformUtils.GetPlatform();

                if (isStatic)
                {
                    List<int> entityIds = gltfsComponents[assetPath.filePath];
                    foreach (int entityId in entityIds)
                    {
                        asset.assetHash.Add(assetPath.hash);
                        Matrix4x4 worldMatrix = GltfTransformDumper.DumpGltfWorldTransforms(staticSceneJSON, entityId);
                        asset.positions.Add(worldMatrix.GetColumn(3));
                        // Rotation extraction
                        Vector3 forward = worldMatrix.GetColumn(2); // Z axis
                        Vector3 up = worldMatrix.GetColumn(1);      // Y axis
                        asset.rotations.Add(Quaternion.LookRotation(forward, up));

                        // Optional: scale extraction
                        Vector3 scale = new Vector3(
                            worldMatrix.GetColumn(0).magnitude,
                            worldMatrix.GetColumn(1).magnitude,
                            worldMatrix.GetColumn(2).magnitude
                        );

                        asset.scales.Add(scale);
                    }

                    // Mark GLTF dependencies as static
                    if (gltfImporters.TryGetValue(assetPath.filePath, out IGltfImport gltfImport))
                    {
                        var dependencies = gltfImport.assetDependencies;
                        if (dependencies != null)
                        {
                            foreach (var dependency in dependencies)
                            {
                                if (!string.IsNullOrEmpty(dependency.assetPath) && !dependency.assetPath.Contains("dcl/scene_ignorel"))
                                {
                                    env.directory.MarkFolderForAssetBundleBuild(dependency.assetPath, "StaticScene");
                                    log.Verbose($"Marked dependency as static: {dependency.assetPath}");
                                }
                            }
                        }
                    }

                }
                bool isStaticTexture = textureComponents.Contains(assetPath.filePath);

                env.directory.MarkFolderForAssetBundleBuild(assetPath.finalPath, (isStatic || isStaticTexture) ? "StaticScene" : assetBundleName);
            }


            ExportToTextAsset(asset, "Assets/_Downloaded/StaticSceneDescriptor.json");
            AssetDatabase.SaveAssets();
            AssetDatabase.Refresh();

            AssetImporter importer_json = AssetImporter.GetAtPath("Assets/_Downloaded/StaticSceneDescriptor.json");
            importer_json.SetAssetBundleNameAndVariant("StaticScene", "");

            void ExportToTextAsset(StaticSceneDescriptor descriptor, string assetPath)
            {
                // Convert ScriptableObject to JSON using Newtonsoft.Json
                var settings = new JsonSerializerSettings
                {
                    Formatting = Formatting.Indented,
                    ReferenceLoopHandling = ReferenceLoopHandling.Ignore
                };
                string json = JsonConvert.SerializeObject(descriptor, settings);
                File.WriteAllText($"{finalDownloadedPath}/StaticSceneDescriptor.json", json);
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

            ForceExit(errorCode);
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
                BuildAssetBundleOptions.None | BuildAssetBundleOptions.ForceRebuildAssetBundle |
                BuildAssetBundleOptions.AssetBundleStripUnityVersion,
                target);

            if (manifest == null)
            {
                var message = "Error generating asset bundle!";
                log.Error(message);
                errorReporter.ReportError(message, settings);
                ForceExit(ErrorCodes.ASSET_BUNDLE_BUILD_FAIL);
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
                BuildAssetBundleOptions.None | BuildAssetBundleOptions.ForceRebuildAssetBundle |
                BuildAssetBundleOptions.AssetBundleStripUnityVersion,
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
        private async Task<bool> ResolveAssets(IReadOnlyList<ContentServerUtils.MappingPair> rawContents)
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

                FilterImportedAssets(gltfPaths, texturePaths, bufferPaths);

                List<Task> downloadTasks = new List<Task>(settings.downloadBatchSize);

                downloadStartupTime = EditorApplication.timeSinceStartup;

                int totalAssetsToDownload = gltfPaths.Count + bufferPaths.Count + texturePaths.Count;
                int progress = 0;

                long GetTotalMegabytesDownloaded() =>
                    downloadedData.Values.Sum(array => array.LongLength) / (1024 * 1024);

                async Task DownloadBatchAsync()
                {
                    await Task.WhenAll(downloadTasks);
                    log.Verbose($"{nameof(ResolveAssets)}: {progress}/{totalAssetsToDownload}; {GetTotalMegabytesDownloaded()} MB");
                    downloadTasks.Clear();
                }

                // start and await in batches
                foreach (AssetPath path in gltfPaths.Concat(bufferPaths).Concat(texturePaths))
                {
                    progress++;

                    downloadTasks.Add(CreateDownloadTask(path));

                    if (downloadTasks.Count >= settings.downloadBatchSize)
                        await DownloadBatchAsync();
                }

                // Download last batch
                if (downloadTasks.Count > 0) await DownloadBatchAsync();

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
                ForceExit(ErrorCodes.DOWNLOAD_FAILED);
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
                ForceExit(ErrorCodes.DOWNLOAD_FAILED);
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
                ForceExit(ErrorCodes.DOWNLOAD_FAILED);
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
        /// Removes assets that are already imported from the list
        /// </summary>
        private void FilterImportedAssets(List<AssetPath> gltfPaths, List<AssetPath> texturePaths, List<AssetPath> bufferPaths)
        {
            // All assets must be re-downloaded
            if (settings.clearDirectoriesOnStart)
                return;

            bool CheckAssetIsImported(AssetPath path)
            {
                var importer = env.assetDatabase.GetImporterAtPath(path.finalPath);

                if (!importer)
                    return false;

                var asset = env.assetDatabase.LoadAssetAtPath<Object>(path.finalPath);
                // in case of a trouble the asset is not imported
                if (!asset || asset.GetType() == typeof(DefaultAsset))
                    return false;

                return true;
            }

            var existingAssetPaths = new List<AssetPath>(gltfPaths.Count + texturePaths.Count + bufferPaths.Count);

            void ProcessImportedAsset(AssetPath assetPath)
            {
                existingAssetPaths.Add(assetPath);
                assetsToMark.Add(assetPath);
            }

            for (int i = gltfPaths.Count - 1; i >= 0; i--)
            {
                var path = gltfPaths[i];
                if (CheckAssetIsImported(path))
                {
                    ProcessImportedAsset(path);
                    gltfPaths.RemoveAt(i);
                }
            }

            AddAssetPathsToContentTable(existingAssetPaths, true);
            existingAssetPaths.Clear();

            for (int i = texturePaths.Count - 1; i >= 0; i--)
            {
                var path = texturePaths[i];
                if (CheckAssetIsImported(path))
                {
                    ProcessImportedAsset(path);
                    texturePaths.RemoveAt(i);
                }
            }

            for (int i = bufferPaths.Count - 1; i >= 0; i--)
            {
                var path = bufferPaths[i];
                if (CheckAssetIsImported(path))
                {
                    ProcessImportedAsset(path);
                    bufferPaths.RemoveAt(i);
                }
            }

            AddAssetPathsToContentTable(existingAssetPaths);
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

            totalGltfs = gltfPaths.Count;

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

            float maxTextureSize = settings.buildTarget is BuildTarget.StandaloneWindows64 or BuildTarget.StandaloneOSX
                ? DESKTOP_MAX_TEXTURE_SIZE
                : DEFAULT_MAX_TEXTURE_SIZE;

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

                    ReduceTextureSizeIfNeeded(finalTexturePath, maxTextureSize);

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
                    gltfImporters[assetPath.filePath] = gltfImport;
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

        private void SetExitState(ErrorCodes error)
        {
            CurrentState.lastErrorCode = error;
        }

        private void ForceExit(ErrorCodes errorCode = ErrorCodes.SUCCESS)
        {
            isExitForced = true;
            env.editor.Exit((int)errorCode);
        }
    }
}
