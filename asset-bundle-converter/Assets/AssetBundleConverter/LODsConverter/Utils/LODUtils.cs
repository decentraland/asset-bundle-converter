using System;
using System.IO;
using UnityEditor;

namespace AssetBundleConverter.LODsConverter.Utils
{
    public class LODUtils
    {
        public static string MoveFileToMatchingFolder(string filePath)
        {
            string fileNameWithoutExtension = Path.GetFileNameWithoutExtension(filePath);
            string currentFolderPath = Path.GetDirectoryName(filePath);

            if (currentFolderPath.EndsWith(fileNameWithoutExtension))
            {
                Console.WriteLine("The file is already in the correct folder.");
                return filePath;
            }

            string targetFolderPath = Path.Combine(currentFolderPath, fileNameWithoutExtension);
            Directory.CreateDirectory(targetFolderPath);

            // Create a new path for the file in the new folder
            string newFilePath = Path.Combine(targetFolderPath, Path.GetFileName(filePath));

            // Move the file to the new folder
            File.Move(filePath, newFilePath);
            // Save assets and refresh the AssetDatabase
            AssetDatabase.SaveAssets();
            AssetDatabase.Refresh();
            return newFilePath;
        }
    }
}