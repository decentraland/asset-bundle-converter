using AssetBundleConverter.Wrappers.Interfaces;
using DCL.ABConverter;
using System;
using System.Collections.Generic;
using UnityEditor;
using UnityEngine;
using Object = UnityEngine.Object;

namespace DCL
{
    public static partial class UnityEditorWrappers
    {
        public class AssetDatabase : IAssetDatabase
        {
            public void Refresh(ImportAssetOptions options = ImportAssetOptions.Default) { UnityEditor.AssetDatabase.Refresh(options); }

            public void SaveAssets() { UnityEditor.AssetDatabase.SaveAssets(); }

            public void ImportAsset(string fullPath, ImportAssetOptions options = ImportAssetOptions.Default)
            {
                string assetPath = PathUtils.FullPathToAssetPath(fullPath);
                UnityEditor.AssetDatabase.ImportAsset(assetPath, options);
            }

            public bool DeleteAsset(string fullPath)
            {
                string assetPath = PathUtils.FullPathToAssetPath(fullPath);
                return UnityEditor.AssetDatabase.DeleteAsset(assetPath);
            }

            public string MoveAsset(string fullPathSrc, string fullPathDst)
            {
                string assetPathSrc = PathUtils.FullPathToAssetPath(fullPathSrc);
                string assetPathDst = PathUtils.FullPathToAssetPath(fullPathDst);
                return UnityEditor.AssetDatabase.MoveAsset(assetPathSrc, assetPathDst);
            }

            public void ReleaseCachedFileHandles() { UnityEditor.AssetDatabase.ReleaseCachedFileHandles(); }

            public T LoadAssetAtPath<T>(string fullPath)
                where T : Object
            {
                string assetPath = PathUtils.FullPathToAssetPath(fullPath);
                return UnityEditor.AssetDatabase.LoadAssetAtPath<T>(assetPath);
            }

            public string GetAssetPath(Object asset) { return PathUtils.AssetPathToFullPath(UnityEditor.AssetDatabase.GetAssetPath(asset)); }

            public string AssetPathToGUID(string fullPath)
            {
                string assetPath = PathUtils.FullPathToAssetPath(fullPath);
                return UnityEditor.AssetDatabase.AssetPathToGUID(assetPath);
            }

            public string GetTextMetaFilePathFromAssetPath(string fullPath)
            {
                string assetPath = PathUtils.FullPathToAssetPath(fullPath);
                return PathUtils.AssetPathToFullPath(UnityEditor.AssetDatabase.GetTextMetaFilePathFromAssetPath(assetPath));
            }

            public AssetImporter GetImporterAtPath(string fullPath)
            {
                string assetPath = PathUtils.FullPathToAssetPath(fullPath);
                var importer = AssetImporter.GetAtPath(assetPath);
                return importer;
            }

            public void BuildMetadata(IFile envFile, string finalDownloadedPath, Dictionary<string, string> lowerCaseHashes, IAssetBundleManifest manifest, string version)
            {
                AssetBundleMetadataBuilder.Generate(envFile, finalDownloadedPath, lowerCaseHashes, manifest, version);
            }
        }
    }
}
