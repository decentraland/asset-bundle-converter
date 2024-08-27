﻿using System.Collections.Generic;

namespace DCL
{
    public interface IDirectory
    {
        void CreateDirectory(string path);
        void InitializeDirectory(string path, bool deleteIfExists);
        void Delete(string path);
        bool Exists(string path);
        void CleanAssetBundleFolder(IFile envFile, string settingsFinalAssetBundlePath, string[] assetBundles, Dictionary<string,string> lowerCaseHashes);

        void MarkFolderForAssetBundleBuild(string assetPathFinalPath, string assetPathHash);
    }
}
