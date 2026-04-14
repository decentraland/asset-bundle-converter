using System;
using System.IO;
using System.Text.RegularExpressions;
using DCL.ABConverter;
using UnityEditor;
using UnityEngine;

namespace AssetBundleConverter.LODsConverter.Utils
{
    public class LODPathHandler
    {
        public string tempPath;
        public string tempPathRelativeToDataPath;

        public string outputPath;

        public string fileDirectoryRelativeToDataPath;
        public string filePathRelativeToDataPath;

        public string filePath;
        public string fileDirectory;
        public string fileName;
        public string fileNameWithoutExtension;

        public string materialsPathRelativeToDataPath;

        public string assetBundleFileName;

        public LODPathHandler(string customOutputPath)
        {
            outputPath = !string.IsNullOrEmpty(customOutputPath) ? customOutputPath : LODConstants.DEFAULT_OUTPUT_PATH;
            tempPath = LODConstants.DEFAULT_TEMP_PATH;
            tempPathRelativeToDataPath = LODConstants.DEFAULT_TEMP_PATH_RELATIVE_TO_DATA_PATH;
            Directory.CreateDirectory(outputPath);
            if (Directory.Exists(tempPath))
                AssetDatabase.DeleteAsset(tempPathRelativeToDataPath);
            AssetDatabase.CreateFolder("Assets", LODConstants.TEMP_FOLDER_NAME);
        }

        public void SetCurrentFile(string downloadedFilePath)
        {
            filePath = downloadedFilePath;
            fileName = Path.GetFileName(filePath);
            fileNameWithoutExtension = Path.GetFileNameWithoutExtension(filePath).ToLower();
            assetBundleFileName = fileNameWithoutExtension + PlatformUtils.GetPlatform();

            fileDirectory = Path.GetDirectoryName(filePath);
            filePathRelativeToDataPath = PathUtils.GetRelativePathTo(Application.dataPath, filePath);
            fileDirectoryRelativeToDataPath = PathUtils.GetRelativePathTo(Application.dataPath, fileDirectory);

            string materialsPath = Path.Combine(fileDirectory, "Materials");
            Directory.CreateDirectory(materialsPath);
            materialsPathRelativeToDataPath = PathUtils.GetRelativePathTo(Application.dataPath, materialsPath);

            AssetDatabase.SaveAssets();
            AssetDatabase.Refresh();
        }

        public void MoveFileToMatchingFolder()
        {
            string newFileDirectory = Path.GetDirectoryName(filePath);

            if (newFileDirectory.EndsWith(fileNameWithoutExtension))
            {
                Console.WriteLine("The file is already in the correct folder.");
                UpdatePaths(filePath);
                return;
            }

            // Use AssetDatabase to move so Unity tracks the asset properly
            string oldRelative = PathUtils.GetRelativePathTo(Application.dataPath, filePath);
            string targetFolderRelative = Path.Combine(Path.GetDirectoryName(oldRelative), fileNameWithoutExtension.ToLower());
            AssetDatabase.CreateFolder(Path.GetDirectoryName(oldRelative), fileNameWithoutExtension.ToLower());
            string newRelative = Path.Combine(targetFolderRelative, fileName);
            string moveResult = AssetDatabase.MoveAsset(oldRelative, newRelative);
            if (!string.IsNullOrEmpty(moveResult))
                Debug.LogError($"[LOD] MoveAsset failed: {moveResult}");

            string newFilePath = Path.Combine(Application.dataPath, newRelative["Assets/".Length..]);
            UpdatePaths(newFilePath);
        }

        private void UpdatePaths(string newFilePath)
        {
            filePath = newFilePath;
            fileDirectory = Path.GetDirectoryName(filePath);
            filePathRelativeToDataPath = PathUtils.GetRelativePathTo(Application.dataPath, filePath);
            fileDirectoryRelativeToDataPath = PathUtils.GetRelativePathTo(Application.dataPath, fileDirectory);

            string materialsPath = Path.Combine(fileDirectory, "Materials");
            Directory.CreateDirectory(materialsPath);
            materialsPathRelativeToDataPath = PathUtils.GetRelativePathTo(Application.dataPath, materialsPath);

            AssetDatabase.SaveAssets();
            AssetDatabase.Refresh();
        }

        public void RelocateOutputFolder()
        {
            string[] files = Directory.GetFiles(outputPath);

            foreach (string file in files)
            {
                try
                {
                    string fileName = Path.GetFileName(file);
                    var match = Regex.Match(fileName, @"[^_]+_(\d+)_[^_]+");
                    if (match.Success)
                    {
                        string number = match.Groups[1].Value;
                        string targetFolderPath = Path.Combine(outputPath, $"{number}");
                        if (!Directory.Exists(targetFolderPath))
                            Directory.CreateDirectory(targetFolderPath);

                        string targetFilePath = Path.Combine(targetFolderPath, fileName);
                        File.Move(file, targetFilePath);
                    }
                }
                catch (Exception ex)
                {
                    Console.WriteLine($"Error processing file '{file}': {ex.Message}");
                }
            }
        }
    }
}
