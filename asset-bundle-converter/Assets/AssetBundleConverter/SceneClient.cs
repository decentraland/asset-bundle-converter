using AssetBundleConverter;
using System;
using System.Collections.Generic;
using System.Linq;
using System.Threading.Tasks;
using UnityEngine;

namespace DCL.ABConverter
{
    public static class SceneClient
    {
        private static Logger log = new Logger("ABConverter.SceneClient");
        public static Environment env;

        public static Environment EnsureEnvironment()
        {
            if (env == null)
                env = Environment.CreateWithDefaultImplementations();

            return env;
        }

        /// <summary>
        /// Scenes conversion batch-mode entry point
        /// </summary>
        public static void ExportSceneToAssetBundles()
        {
            //NOTE(Brian): This should make the logs cleaner
            Application.SetStackTraceLogType(LogType.Log, StackTraceLogType.None);
            Application.SetStackTraceLogType(LogType.Warning, StackTraceLogType.None);
            Application.SetStackTraceLogType(LogType.Error, StackTraceLogType.Full);
            Application.SetStackTraceLogType(LogType.Exception, StackTraceLogType.Full);
            Application.SetStackTraceLogType(LogType.Assert, StackTraceLogType.Full);

            EnsureEnvironment();
            ExportSceneToAssetBundles(System.Environment.GetCommandLineArgs());
        }

        /// <summary>
        /// Start the scene conversion process with the given commandLineArgs.
        /// </summary>
        /// <param name="commandLineArgs">An array with the command line arguments.</param>
        /// <exception cref="ArgumentException">When an invalid argument is passed</exception>
        public async static void ExportSceneToAssetBundles(string[] commandLineArgs)
        {
            ClientSettings settings = new ClientSettings();
            try
            {
                if (Utils.ParseOption(commandLineArgs, Config.CLI_SET_CUSTOM_OUTPUT_ROOT_PATH, 1, out string[] outputPath))
                {
                    settings.finalAssetBundlePath = outputPath[0] + "/";
                }

                if (Utils.ParseOption(commandLineArgs, Config.CLI_SET_CUSTOM_BASE_URL, 1, out string[] customBaseUrl))
                    settings.baseUrl = customBaseUrl[0];

                if (Utils.ParseOption(commandLineArgs, Config.CLI_VERBOSE, 0, out _))
                    settings.verbose = true;

                if (Utils.ParseOption(commandLineArgs, Config.CLI_ALWAYS_BUILD_SYNTAX, 0, out _))
                    settings.skipAlreadyBuiltBundles = false;

                if (Utils.ParseOption(commandLineArgs, Config.CLI_KEEP_BUNDLES_SYNTAX, 0, out _))
                    settings.deleteDownloadPathAfterFinished = false;

                if (Utils.ParseOption(commandLineArgs, Config.CLI_BUILD_SCENE_SYNTAX, 1, out string[] sceneCid))
                {
                    if (sceneCid == null || string.IsNullOrEmpty(sceneCid[0]))
                    {
                        throw new ArgumentException("Invalid sceneCid argument! Please use -sceneCid <id> to establish the desired id to process.");
                    }

                    await ConvertEntityById(sceneCid[0], settings);
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

                    // TODO:
                    //await DumpArea(new Vector2Int(x, y), new Vector2Int(w, h), settings);
                    return;
                }

                throw new ArgumentException("Invalid arguments! You must pass -parcelsXYWH or -sceneCid for dump to work!");
            }
            catch (Exception e)
            {
                log.Error(e.Message);
            }
        }

        /// <summary>
        /// Dump a single decentraland entity given an id.
        /// </summary>
        /// <param name="entityId">The scene cid in the multi-hash format (i.e. Qm...etc)</param>
        /// <param name="settings">Conversion settings</param>
        /// <returns>A state context object useful for tracking the conversion progress</returns>
        public static async Task<AssetBundleConverter.State> ConvertEntityById(string entityId, ClientSettings settings = null)
        {
            EnsureEnvironment();

            if (settings == null)
                settings = new ClientSettings();

            var apiResponse = Utils.GetEntityMappings(entityId, settings.tld, env.webRequest);
            var mappings = apiResponse.SelectMany(m => m.content);
            return await ConvertEntitiesToAssetBundles(mappings.ToArray(), settings);

        }

        /// <summary>
        /// Dump a single decentraland entity given a pointer
        /// </summary>
        /// <param name="pointer">The entity position in world</param>
        /// <param name="settings">Conversion settings</param>
        /// <returns>A state context object useful for tracking the conversion progress</returns>
        public static async Task<AssetBundleConverter.State> ConvertEntityByPointer(Vector2Int pointer, ClientSettings settings = null)
        {
            EnsureEnvironment();

            if (settings == null)
                settings = new ClientSettings();

            var apiResponse = Utils.GetEntityMappings(pointer, settings.tld, env.webRequest);
            var mappings = apiResponse.SelectMany(m => m.content);
            return await ConvertEntitiesToAssetBundles(mappings.ToArray(), settings);
        }

        /// <summary>
        /// This will start the asset bundle conversion for a given scene list, given a scene cids list.
        /// </summary>
        /// <param name="entitiesId">The cid list for the scenes to gather from the catalyst's content server</param>
        /// <param name="settings">Any conversion settings object, if its null, a new one will be created</param>
        /// <returns>A state context object useful for tracking the conversion progress</returns>
        private static async Task<AssetBundleConverter.State> ConvertEntitiesToAssetBundles(ContentServerUtils.MappingPair[] mappingPairs, ClientSettings settings = null)
        {
            if (mappingPairs == null || mappingPairs.Length == 0)
            {
                log.Error("Entity list is null or count == 0! Maybe this sector lacks scenes or content requests failed?");
                return new AssetBundleConverter.State { lastErrorCode = AssetBundleConverter.ErrorCodes.SCENE_LIST_NULL };
            }

            log.Info($"Converting {mappingPairs.Length} entities...");

            EnsureEnvironment();

            if (settings == null)
                settings = new ClientSettings();

            var core = new AssetBundleConverter(env, settings);
            await core.Convert(mappingPairs);
            return core.CurrentState;
        }
    }
}
