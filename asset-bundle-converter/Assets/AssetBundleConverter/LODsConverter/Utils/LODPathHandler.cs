using System;
using System.IO;
using DCL.ABConverter;
using UnityEditor;
using UnityEngine;

namespace AssetBundleConverter.LODsConverter.Utils
{
    public class LODPathHandler
    {
        public string tempPath;
        public string outputPath;

        public string fileDirectoryRelativeToDataPath;
        public string filePathRelativeToDataPath;

        public string filePath;
        public string fileName;
        public string fileNameWithoutExtension;

        public string materialsPathRelativeToDataPath;

        public string assetBundlePath;
        public string assetBundleFileName;

        public string prefabPathRelativeToDataPath;

        public LODPathHandler(string customOutputPath)
        {
            outputPath = !string.IsNullOrEmpty(customOutputPath) ? customOutputPath : LODConstants.DEFAULT_OUTPUT_PATH;
            tempPath = LODConstants.DEFAULT_TEMP_PATH;

            Directory.CreateDirectory(outputPath);
            Directory.CreateDirectory(tempPath);
        }

        public void SetCurrentFile(string downloadedFilePath)
        {
            filePath = downloadedFilePath;
            fileName = Path.GetFileName(filePath);
            fileNameWithoutExtension = Path.GetFileNameWithoutExtension(filePath);
            assetBundleFileName = fileNameWithoutExtension + PlatformUtils.GetPlatform();
            assetBundlePath = Path.Combine(outputPath, assetBundleFileName);
        }
        
        public void MoveFileToMatchingFolder()
        {
            string fileDirectory = Path.GetDirectoryName(filePath);

            if (fileDirectory.EndsWith(fileNameWithoutExtension))
            {
                Console.WriteLine("The file is already in the correct folder.");
                UpdatePaths(filePath);
                return;
            }

            string targetFolderPath = Path.Combine(fileDirectory, fileNameWithoutExtension);
            Directory.CreateDirectory(targetFolderPath);
            string newFilePath = Path.Combine(targetFolderPath, fileName);
            File.Move(filePath, newFilePath);

            UpdatePaths(newFilePath);
        }

        private void UpdatePaths(string newFilePath)
        {
            filePath = newFilePath;
            string fileDirectory = Path.GetDirectoryName(filePath);
            filePathRelativeToDataPath = PathUtils.GetRelativePathTo(Application.dataPath, filePath);
            fileDirectoryRelativeToDataPath = PathUtils.GetRelativePathTo(Application.dataPath, fileDirectory);

            string materialsPath = Path.Combine(fileDirectory, "Materials");
            Directory.CreateDirectory(materialsPath);
            materialsPathRelativeToDataPath = PathUtils.GetRelativePathTo(Application.dataPath, materialsPath);

            prefabPathRelativeToDataPath = PathUtils.GetRelativePathTo(Application.dataPath, fileDirectory + "/" + fileNameWithoutExtension + ".prefab");
            // Save assets and refresh the AssetDatabase
            AssetDatabase.SaveAssets();
            AssetDatabase.Refresh();
        }
    }
}