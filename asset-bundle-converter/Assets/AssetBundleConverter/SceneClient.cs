using AssetBundleConverter;
using AssetBundleConverter.Wearables;
using System;
using System.Collections.Generic;
using System.Linq;
using System.Threading.Tasks;
using UnityEditor;
using UnityEngine;
using Environment = AssetBundleConverter.Environment;

namespace DCL.ABConverter
{
    public static class SceneClient
    {
        private static ABLogger log = new ABLogger("ABConverter.SceneClient");

        public static Environment env;

        public static Environment EnsureEnvironment(BuildPipelineType buildPipeline) =>
            env ??= Environment.CreateWithDefaultImplementations(buildPipeline);

        /// <summary>
        /// Scenes conversion batch-mode entry point
        /// </summary>
        public static void ExportSceneToAssetBundles()
        {
            try
            {
                //NOTE(Brian): This should make the logs cleaner
#if !UNITY_EDITOR
                Application.SetStackTraceLogType(LogType.Log, StackTraceLogType.None);
                Application.SetStackTraceLogType(LogType.Warning, StackTraceLogType.None);
                Application.SetStackTraceLogType(LogType.Error, StackTraceLogType.Full);
                Application.SetStackTraceLogType(LogType.Exception, StackTraceLogType.Full);
                Application.SetStackTraceLogType(LogType.Assert, StackTraceLogType.Full);
#endif
                ExportSceneToAssetBundles(System.Environment.GetCommandLineArgs());
            }
            catch (Exception e)
            {
                Debug.LogException(e);
                Utils.Exit((int)AssetBundleConverter.ErrorCodes.UNEXPECTED_ERROR);
            }
        }

        /// <summary>
        /// Wearables collection conversion batch-mode entry point
        /// </summary>
        public static void ExportWearablesCollectionToAssetBundles()
        {
            try
            {
                //NOTE(Brian): This should make the logs cleaner
                Application.SetStackTraceLogType(LogType.Log, StackTraceLogType.None);
                Application.SetStackTraceLogType(LogType.Warning, StackTraceLogType.None);
                Application.SetStackTraceLogType(LogType.Error, StackTraceLogType.Full);
                Application.SetStackTraceLogType(LogType.Exception, StackTraceLogType.Full);
                Application.SetStackTraceLogType(LogType.Assert, StackTraceLogType.Full);

                ExportWearablesCollectionToAssetBundles(System.Environment.GetCommandLineArgs());
            }
            catch (Exception e)
            {
                Debug.LogException(e);
                Utils.Exit((int)AssetBundleConverter.ErrorCodes.UNEXPECTED_ERROR);
            }
        }

        /// <summary>
        /// Start the scene conversion process with the given commandLineArgs.
        /// </summary>
        /// <param name="commandLineArgs">An array with the command line arguments.</param>
        /// <exception cref="ArgumentException">When an invalid argument is passed</exception>
        public async static void ExportSceneToAssetBundles(string[] commandLineArgs, ClientSettings settings = default)
        {
            settings ??= new ClientSettings();
            settings.reportErrors = true;
            try
            {
                ParseCommonSettings(commandLineArgs, settings);

                if (Utils.ParseOption(commandLineArgs, Config.CLI_SET_SHADER_TARGET, 1, out string[] shaderTarget))
                {
                    string target = shaderTarget[0].ToLower();

                    settings.shaderType = target switch
                                          {
                                              "dcl" => ShaderType.Dcl,
                                              "gltfast" => ShaderType.GlTFast,
                                              _ => settings.shaderType
                                          };
                }

                if (Utils.ParseOption(commandLineArgs, Config.CLI_BUILD_SCENE_SYNTAX, 1, out string[] sceneCid))
                {
                    if (sceneCid == null || string.IsNullOrEmpty(sceneCid[0]))
                    {
                        throw new ArgumentException("Invalid sceneCid argument! Please use -sceneCid <id> to establish the desired id to process.");
                    }

                    settings.targetHash = sceneCid[0];
                    await ConvertEntityById(settings);
                    return;
                }

                bool isPointerValid = true;
                var targetPoint = new Vector2Int();
                if (Utils.ParseOption(commandLineArgs, Config.CLI_SET_POSITION_X, 1, out string[] posX))
                {
                    isPointerValid &= int.TryParse(posX[0].Replace("\"", string.Empty), out int resultX);
                    targetPoint.x = resultX;
                }

                if (Utils.ParseOption(commandLineArgs, Config.CLI_SET_POSITION_Y, 1, out string[] posY))
                {
                    isPointerValid &= int.TryParse(posY[0].Replace("\"", string.Empty), out int resultY);
                    targetPoint.y = resultY;
                }

                if (isPointerValid)
                {
                    settings.targetPointer = targetPoint;
                    await ConvertEntityByPointer(settings);
                    return;
                }

                if (Utils.ParseOption(commandLineArgs, Config.CLI_BUILD_PARCELS_RANGE_SYNTAX, 4, out string[] xywh))
                {
                    if (xywh == null)
                    {
                        throw new ArgumentException("Invalid parcelsXYWH argument! Please use -parcelsXYWH x y w h to establish the desired parcels range to process.");
                    }

                    int x, y, w, h;
                    bool parseSuccess = false;

                    parseSuccess |= int.TryParse(xywh[0], out x);
                    parseSuccess |= int.TryParse(xywh[1], out y);
                    parseSuccess |= int.TryParse(xywh[2], out w);
                    parseSuccess |= int.TryParse(xywh[3], out h);

                    if (!parseSuccess)
                    {
                        throw new ArgumentException("Invalid parcelsXYWH argument! Please use -parcelsXYWH x y w h to establish the desired parcels range to process.");
                    }

                    if (w > 10 || h > 10 || w < 0 || h < 0)
                    {
                        throw new ArgumentException("Invalid parcelsXYWH argument! Please don't use negative width/height values, and ensure any given width/height doesn't exceed 10.");
                    }

                    log.Error("-parcelsXYWH is deprecated!");
                    return;
                }

                throw new ArgumentException("Invalid arguments! You must pass (-x and -y) or -sceneCid for the converter to work!");
            }
            catch (Exception e)
            {
                Debug.LogException(e);
                log.Exception(e.ToString());
                Utils.Exit((int)AssetBundleConverter.ErrorCodes.UNEXPECTED_ERROR);
            }
        }

        /// <summary>
        /// Start the wearables collection conversion process with the given commandLineArgs.
        /// </summary>
        /// <param name="commandLineArgs">An array with the command line arguments.</param>
        /// <exception cref="ArgumentException">When an invalid argument is passed</exception>
        public static async void ExportWearablesCollectionToAssetBundles(string[] commandLineArgs)
        {
            ClientSettings settings = new ClientSettings();
            try
            {
                ParseCommonSettings(commandLineArgs, settings);

                if (Utils.ParseOption(commandLineArgs, Config.CLI_BUILD_WEARABLES_COLLECTION_SYNTAX, 1, out string[] collectionId))
                {
                    if (collectionId == null || string.IsNullOrEmpty(collectionId[0]))
                    {
                        throw new ArgumentException("Invalid wearablesCollectionUrnId argument! Please use -wearablesCollectionUrnId <id> to establish the desired collection id to process.");
                    }

                    log.Info("found 'wearablesCollectionUrnId' param, will try to convert collection with id: " + collectionId[0]);

                    settings.targetHash = collectionId[0];

                    await ConvertWearablesCollection(settings);

                    return;
                }

                // TODO This branch does nothing as DumpWearablesCollectionRange is commented
                if (Utils.ParseOption(commandLineArgs, Config.CLI_BUILD_WEARABLES_COLLECTION_RANGE_START_SYNTAX, 1, out string[] firstCollectionIndex))
                {
                    if (firstCollectionIndex == null || string.IsNullOrEmpty(firstCollectionIndex[0]))
                    {
                        throw new ArgumentException("Invalid firstCollectionIndex argument! Please use -firstCollectionIndex <index> to define the first collection to convert in the batch");
                    }
                    int firstCollectionIndexInt = Int32.Parse(firstCollectionIndex[0]);

                    if (Utils.ParseOption(commandLineArgs, Config.CLI_BUILD_WEARABLES_COLLECTION_RANGE_END_SYNTAX, 1, out string[] lastCollectionIndex))
                    {
                        if (lastCollectionIndex == null || string.IsNullOrEmpty(lastCollectionIndex[0]))
                            throw new ArgumentException("Invalid wearablesLastCollectionIndex argument! Please use -wearablesLastCollectionIndex <index> to define the last collection to convert in the batch");

                        int lastCollectionIndexInt = Int32.Parse(lastCollectionIndex[0]);

                        if (lastCollectionIndexInt < firstCollectionIndexInt)
                            throw new ArgumentException("Invalid wearablesLastCollectionIndex argument! Please use a wearablesLastCollectionIndex that's equal or higher than the first collection index");

                        //DumpWearablesCollectionRange(firstCollectionIndexInt, lastCollectionIndexInt, settings);
                        log.Error("Converting multiple collections is not supported!");
                        return;
                    }
                }

                throw new ArgumentException("Invalid arguments! You must pass -wearablesCollectionUrnId for dump to work!");
            }
            catch (Exception e)
            {
                log.Error(e.Message);
            }
        }

        private static void ParseCommonSettings(string[] commandLineArgs, ClientSettings settings)
        {
            if (Utils.ParseOption(commandLineArgs, Config.CLI_SET_CUSTOM_OUTPUT_ROOT_PATH, 1, out string[] outputPath))
                settings.finalAssetBundlePath = outputPath[0] + "/";

            if (Utils.ParseOption(commandLineArgs, Config.CLI_SET_CUSTOM_BASE_URL, 1, out string[] customBaseUrl))
                settings.baseUrl = customBaseUrl[0];

            if (Utils.ParseOption(commandLineArgs, Config.CLI_SET_SHADER, 1, out string[] shaderParam))
            {
                var shader = shaderParam[0];

                settings.shaderType = shader switch
                                      {
                                          "dcl" => ShaderType.Dcl,
                                          "gltfast" => ShaderType.GlTFast,
                                          _ => settings.shaderType
                                      };
            }

            if (Utils.ParseOption(commandLineArgs, Config.CLI_BUILD_PIPELINE, 1, out string[] pipelineParam)
                && Enum.TryParse(pipelineParam[0], true, out BuildPipelineType pipeline))
            {
                settings.BuildPipelineType = pipeline;
            }

            if (Utils.ParseOption(commandLineArgs, Config.CLI_VERBOSE, 0, out _))
                settings.verbose = true;

            if (Utils.ParseOption(commandLineArgs, Config.CLI_ALWAYS_BUILD_SYNTAX, 0, out _))
                settings.skipAlreadyBuiltBundles = false;

            if (Utils.ParseOption(commandLineArgs, Config.CLI_KEEP_BUNDLES_SYNTAX, 0, out _))
                settings.deleteDownloadPathAfterFinished = false;

            // Target is setup during the commandline argument -buildTarget
            settings.buildTarget = EditorUserBuildSettings.activeBuildTarget;
        }

        /// <summary>
        /// Dump a single decentraland entity given an id.
        /// </summary>
        /// <param name="entityId">The scene cid in the multi-hash format (i.e. Qm...etc)</param>
        /// <param name="settings">Conversion settings</param>
        /// <returns>A state context object useful for tracking the conversion progress</returns>
        public static async Task<AssetBundleConverter.State> ConvertEntityById(ClientSettings settings)
        {
            EnsureEnvironment(settings.BuildPipelineType);

            var apiResponse = await Utils.GetEntityMappingsAsync(settings.targetHash, settings, env.webRequest);
            if (apiResponse == null) return GetUnexpectedResult();
            var mappings = apiResponse.SelectMany(m => m.content);
            return await ConvertEntitiesToAssetBundles(mappings.ToArray(), settings);
        }

        public static async Task<AssetBundleConverter.State> ConvertEmptyScenesByMapping(ClientSettings settings)
        {
            EnsureEnvironment(settings.BuildPipelineType);
            return await ConvertEntitiesToAssetBundles(await Utils.GetEmptyScenesMappingAsync(settings.targetHash, settings, env.webRequest), settings);
        }

        /// <summary>
        /// Dump a single decentraland entity given a pointer
        /// </summary>
        /// <param name="pointer">The entity position in world</param>
        /// <param name="settings">Conversion settings</param>
        /// <returns>A state context object useful for tracking the conversion progress</returns>
        public static async Task<AssetBundleConverter.State> ConvertEntityByPointer(ClientSettings settings)
        {
            EnsureEnvironment(settings.BuildPipelineType);

            var apiResponse = await Utils.GetEntityMappings(settings.targetPointer.Value, settings, env.webRequest);
            if (apiResponse == null) return GetUnexpectedResult();
            var mappings = apiResponse.SelectMany(m => m.content);
            return await ConvertEntitiesToAssetBundles(mappings.ToArray(), settings);
        }

        private static AssetBundleConverter.State GetUnexpectedResult() =>
            new (){step = AssetBundleConverter.State.Step.IDLE, lastErrorCode = AssetBundleConverter.ErrorCodes.UNEXPECTED_ERROR};

        public static async Task<AssetBundleConverter.State> ConvertWearablesCollection(ClientSettings settings)
        {
            EnsureEnvironment(settings.BuildPipelineType);

            settings.isWearable = true;

            var mappings = await WearablesClient.GetCollectionMappingsAsync(settings.targetHash, ContentServerUtils.ApiTLD.ORG, env.webRequest);
            return await ConvertEntitiesToAssetBundles(mappings, settings);
        }

        /// <summary>
        /// This will start the asset bundle conversion for a given scene list, given a scene cids list.
        /// </summary>
        /// <param name="entitiesId">The cid list for the scenes to gather from the catalyst's content server</param>
        /// <param name="settings">Any conversion settings object, if its null, a new one will be created</param>
        /// <returns>A state context object useful for tracking the conversion progress</returns>
        private static async Task<AssetBundleConverter.State> ConvertEntitiesToAssetBundles(IReadOnlyList<ContentServerUtils.MappingPair> mappingPairs, ClientSettings settings)
        {
            if (mappingPairs == null || mappingPairs.Count == 0)
            {
                log.Error("Entity list is null or count == 0! Maybe this sector lacks scenes or content requests failed?");
                return new AssetBundleConverter.State { lastErrorCode = AssetBundleConverter.ErrorCodes.SCENE_LIST_NULL };
            }

            log.Info($"Converting {mappingPairs.Count} entities...");

            log.Info(string.Join('\n',mappingPairs.Select(mp => mp.file)));

            EnsureEnvironment(settings.BuildPipelineType);

            var core = new AssetBundleConverter(env, settings);
            await core.ConvertAsync(mappingPairs);
            return core.CurrentState;
        }
    }
}
