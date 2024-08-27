using DCL.ABConverter;
using System;
using System.Collections.Generic;
using UnityEngine;
using System.IO;

namespace DCL
{
    public static partial class SystemWrappers
    {
        public class Directory : IDirectory
        {
            public void CreateDirectory(string path) { System.IO.Directory.CreateDirectory(path); }

            public void InitializeDirectory(string path, bool deleteIfExists)
            {
                try
                {
                    if (deleteIfExists)
                    {
                        if (Exists(path))
                            Delete(path);
                    }

                    if (!Exists(path))
                        CreateDirectory(path);
                }
                catch (Exception e)
                {
                    Debug.LogError($"Exception trying to clean up folder. Continuing anyways.\n{e.Message}");
                }
            }

            public void Delete(string path)
            {
                try
                {
                    if (Exists(path))
                        DeleteDirectory(path);
                }
                catch (Exception e)
                {
                    Debug.LogError($"Error trying to delete directory {path}!\n{e.Message}");
                }
            }

            private static void DeleteDirectory(string targetDir)
            {
                // Delete all files in the directory
                string[] files = System.IO.Directory.GetFiles(targetDir);
                foreach (string file in files)
                {
                    File.SetAttributes(file, FileAttributes.Normal); // Ensure the file is not read-only
                    File.Delete(file);
                }

                // Delete all subdirectories in the directory
                string[] subDirs = System.IO.Directory.GetDirectories(targetDir);
                foreach (string subDir in subDirs)
                {
                    DeleteDirectory(subDir); // Recursively delete subdirectories
                }

                // Delete the empty directory
                System.IO.Directory.Delete(targetDir, false);
            }

            public bool Exists(string path) { return System.IO.Directory.Exists(path); }

            public void CleanAssetBundleFolder(IFile envFile, string settingsFinalAssetBundlePath, string[] assetBundles, Dictionary<string, string> lowerCaseHashes)
            {
                Utils.CleanAssetBundleFolder(envFile, settingsFinalAssetBundlePath, assetBundles, lowerCaseHashes);
            }

            public void MarkFolderForAssetBundleBuild(string assetPathFinalPath, string assetPathHash)
            {
                Utils.MarkFolderForAssetBundleBuild(assetPathFinalPath, assetPathHash);
            }
        }
    }
}
