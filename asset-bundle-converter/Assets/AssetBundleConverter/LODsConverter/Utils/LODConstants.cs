using System.IO;
using DCL.ABConverter;
using UnityEngine;

namespace AssetBundleConverter.LODsConverter.Utils
{
    public class LODConstants
    {
        public static string DEFAULT_OUTPUT_PATH = Config.ASSET_BUNDLES_PATH_ROOT + Path.DirectorySeparatorChar;
        public static string TEMP_FOLDER_NAME = "temp";
        public static string DEFAULT_TEMP_PATH = Path.Combine(Application.dataPath, TEMP_FOLDER_NAME);
        public static string DEFAULT_TEMP_PATH_RELATIVE_TO_DATA_PATH = Path.Combine("Assets", TEMP_FOLDER_NAME);
    }
}