using DCL;
using System;
using System.IO;
using UnityEngine;

namespace AssetBundleConverter.Wrappers.Implementations.Default
{
    public static class SystemWrappers
    {
        public class File : IFile
        {
            public void Delete(string path)
            {
                path = path.ToLowerInvariant();
                try { System.IO.File.Delete(path); }
                catch (Exception e) { Debug.LogError($"Error trying to delete file {path}!\n{e.Message}"); }
            }

            public bool Exists(string path)
            {
                path = path.ToLowerInvariant();
                return System.IO.File.Exists(path);
            }

            public void Copy(string srcPath, string dstPath)
            {
                srcPath = srcPath.ToLowerInvariant();
                dstPath = dstPath.ToLowerInvariant();
                System.IO.File.Copy(srcPath, dstPath);
            }

            public void Move(string srcPath, string dstPath)
            {
                srcPath = srcPath.ToLowerInvariant();
                dstPath = dstPath.ToLowerInvariant();
                System.IO.File.Move(srcPath, dstPath);
            }

            public string ReadAllText(string path)
            {
                path = path.ToLowerInvariant();
                return System.IO.File.ReadAllText(path);
            }

            public void WriteAllText(string path, string text)
            {
                path = path.ToLowerInvariant();
                System.IO.File.WriteAllText(path, text);
            }

            public void WriteAllBytes(string path, byte[] bytes)
            {
                path = path.ToLowerInvariant();
                System.IO.File.WriteAllBytes(path, bytes);
            }

            public Stream OpenRead(string path)
            {
                path = path.ToLowerInvariant();
                return System.IO.File.OpenRead(path);
            }

            public byte[] ReadAllBytes(string texturePath)
            {
                texturePath = texturePath.ToLowerInvariant();
                return System.IO.File.ReadAllBytes(texturePath);
            }
        }
    }
}
