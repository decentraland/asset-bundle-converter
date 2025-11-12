using AssetBundleConverter.Editor;
using AssetBundleConverter.Wrappers.Interfaces;
using System.Collections.Generic;
using UnityEditor;
using UnityEngine;

namespace DCL
{
    public interface IAssetDatabase
    {
        void Refresh(ImportAssetOptions options = ImportAssetOptions.Default);
        void SaveAssets();
        void ImportAsset(string fullPath, ImportAssetOptions options = ImportAssetOptions.Default);
        bool DeleteAsset(string path);
        string MoveAsset(string src, string dst);
        void ReleaseCachedFileHandles();
        T LoadAssetAtPath<T>(string path) where T : Object;
        string GetAssetPath(Object asset);
        string AssetPathToGUID(string path);
        string GetTextMetaFilePathFromAssetPath(string path);
        AssetImporter GetImporterAtPath(string path);
        void BuildMetadata(IFile envFile, string finalDownloadedPath, Dictionary<string,string> lowerCaseHashes, IAssetBundleManifest manifest, string version, AssetBundleMetadata.SocialEmoteOutcomeAnimationPose[] socialEmoteOutcomeAnimationStartPoses);
        void SaveImporter(AssetImporter gltfImporter);

        void CreateAsset(Object obj, string path);
        void AssignAssetBundle(Shader shader, bool withVariants);
        void MarkAssetBundle(Object asset, string abName);
    }
}
