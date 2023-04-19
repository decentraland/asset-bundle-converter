using DCL.ABConverter;
using System;
using System.Collections.Generic;
using UnityEngine;

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
                            Delete(path, true);
                    }

                    if (!Exists(path))
                        CreateDirectory(path);
                }
                catch (Exception e)
                {
                    Debug.LogError($"Exception trying to clean up folder. Continuing anyways.\n{e.Message}");
                }
            }

            public void Delete(string path, bool recursive)
            {
                try
                {
                    if (Exists(path))
                        System.IO.Directory.Delete(path, recursive);
                }
                catch (Exception e)
                {
                    Debug.LogError($"Error trying to delete directory {path}!\n{e.Message}");
                }
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
