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
        [MenuItem("Decentraland/LOD/Export URL LODs")]
        public static async void ExportURLLODsToAssetBundles()
        {
            string[] commandLineArgs = Environment.GetCommandLineArgs();
            
            string customOutputDirectory = "";
            string lodsURL = "https://lods-bucket-ed4300a.s3.amazonaws.com/-17,-21/LOD/Sources/1707776785658/bafkreidnwpjkv3yoxsz6iiqh3fahuec7lfsqtmkyz3yf6dgps454ngldnu_0.fbx;" +
                             "https://lods-bucket-ed4300a.s3.amazonaws.com/-17,-21/LOD/Sources/1707776785658/bafkreidnwpjkv3yoxsz6iiqh3fahuec7lfsqtmkyz3yf6dgps454ngldnu_1.fbx;" +
                             "https://lods-bucket-ed4300a.s3.amazonaws.com/-17,-21/LOD/Sources/1707776785658/bafkreidnwpjkv3yoxsz6iiqh3fahuec7lfsqtmkyz3yf6dgps454ngldnu_2.fbx";

            if (Utils.ParseOption(commandLineArgs, Config.LODS_URL, 1, out string[] lodsURLArg))
                lodsURL = lodsURLArg[0];

            if (Utils.ParseOption(commandLineArgs, Config.CLI_SET_CUSTOM_OUTPUT_ROOT_PATH, 1, out string[] outputDirectoryArg))
                customOutputDirectory = outputDirectoryArg[0] + "/";

            var lodConversion = new LODConversion(customOutputDirectory, lodsURL.Split(";"));
            await lodConversion.ConvertLODs();
        }

        [MenuItem("Decentraland/LOD/Export FBX Folder To Asset Bundles")]
        private static async void ExportFBXToAssetBundles()
        {
            string[] fileEntries = Directory.GetFiles(Path.Combine(Application.dataPath, "AssetBundleConverter/LODsConverter/ExportLODToAssetBundle"), "*.fbx", SearchOption.AllDirectories);
            if (fileEntries.Length > 0)
            {
                var lodConversion = new LODConversion(LODConstants.DEFAULT_OUTPUT_PATH, fileEntries);
                await lodConversion.ConvertLODs();
            }
        }
        
    }
}