using System;
using UnityEngine;
using UnityEditor;
using System.IO;
using System.Collections.Generic;
using System.Threading.Tasks;
using AssetBundleConverter.LODsConverter.Utils;
using AssetBundleConverter.Wrappers.Interfaces;
using UnityEngine.Rendering;
using Object = UnityEngine.Object;

namespace DCL.ABConverter
{
    public class LODClient : MonoBehaviour
    {
        //Used by the consumer-server
        public static async void ExportURLLODsToAssetBundles()
        {
            string[] commandLineArgs = Environment.GetCommandLineArgs();
            
            string customOutputDirectory = "";
            string lodsURL = "";

            if (Utils.ParseOption(commandLineArgs, Config.LODS_URL, 1, out string[] lodsURLArg))
                lodsURL = lodsURLArg[0];

            if (Utils.ParseOption(commandLineArgs, Config.CLI_SET_CUSTOM_OUTPUT_ROOT_PATH, 1, out string[] outputDirectoryArg))
                customOutputDirectory = outputDirectoryArg[0] + "/";

            var lodConversion = new LODConversion(customOutputDirectory, lodsURL.Split(";"));
            await lodConversion.ConvertLODs();
        }

        [MenuItem("Decentraland/LOD/Export URL LODs")]
        public static void ExportURLLODsToAssetBundlesLocal()
        {
            URLLODWindow.Open(OnConvert);
        }

        [MenuItem("Decentraland/LOD/Export Local FBX LODs")]
        private static void ExportFBXToAssetBundlesLocal()
        {
            DragAndDropLODWindow.Open(OnConvert);
        }

        private static async void OnConvert(List<string> fbxFilesPaths)
        {
            var lodConversion = new LODConversion(LODConstants.DEFAULT_OUTPUT_PATH, fbxFilesPaths.ToArray());
            await lodConversion.ConvertLODs();
        }
        
    }
}