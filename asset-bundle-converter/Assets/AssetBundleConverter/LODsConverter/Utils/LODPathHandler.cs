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

            Directory.CreateDirectory(outputPath);
            Directory.CreateDirectory(tempPath);
        }

        public void SetCurrentFile(string downloadedFilePath)
        {
            filePath = downloadedFilePath;
            fileName = Path.GetFileName(filePath);
            fileNameWithoutExtension = Path.GetFileNameWithoutExtension(filePath).ToLower();
            assetBundleFileName = fileNameWithoutExtension + PlatformUtils.GetPlatform();
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

            string targetFolderPath = Path.Combine(newFileDirectory, fileNameWithoutExtension.ToLower());
            Directory.CreateDirectory(targetFolderPath);
            string newFilePath = Path.Combine(targetFolderPath, fileName);
            File.Move(filePath, newFilePath);

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
            

            // Save assets and refresh the AssetDatabase
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
                    // Extract the numeric value (X) from the filename
                    string fileName = Path.GetFileName(file);
                    var match = Regex.Match(Path.GetFileName(file), @"[^_]+_(\d+)_[^_]+");
                    if (match.Success)
                    {
                        string number = match.Groups[1].Value;

                        // Create target folder path (e.g., "LOD/0")
                        string targetFolderPath = Path.Combine(outputPath, $"{number}");
                        if (!Directory.Exists(targetFolderPath))
                        {
                            Directory.CreateDirectory(targetFolderPath);
                        }

                        // Move the file to the target folder
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