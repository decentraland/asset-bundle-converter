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

        public string filePath;
        public string fileDirectoryRelativeToDataPath;
        public string filePathRelativeToDataPath;

        public string fileName;
        public string fileNameWithoutExtension;

        public string materialsPathRelativeToDataPath;

        public string assetBundlePath;
        public string assetBundleFileName;

        public string prefabPathRelativeToDataPath;


        public LODPathHandler(string tempPath, string outputPath, string filePath)
        {
            this.tempPath = tempPath;
            this.filePath = filePath;
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
                filePathRelativeToDataPath = PathUtils.GetRelativePathTo(Application.dataPath, filePath);
                return;
            }

            string targetFolderPath = Path.Combine(fileDirectory, fileNameWithoutExtension);
            Directory.CreateDirectory(targetFolderPath);

            // Create a new path for the file in the new folder
            string newFilePath = Path.Combine(targetFolderPath, fileName);

            // Move the file to the new folder
            File.Move(filePath, newFilePath);

            filePath = newFilePath;
            fileDirectory = Path.GetDirectoryName(filePath);
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