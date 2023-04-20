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
                try { System.IO.File.Delete(path); }
                catch (Exception e) { Debug.LogError($"Error trying to delete file {path}!\n{e.Message}"); }
            }

            public bool Exists(string path) =>
                System.IO.File.Exists(path);

            public void Copy(string srcPath, string dstPath)
            {
                System.IO.File.Copy(srcPath, dstPath);
            }

            public void Move(string srcPath, string dstPath)
            {
                System.IO.File.Move(srcPath, dstPath);
            }

            public string ReadAllText(string path) =>
                System.IO.File.ReadAllText(path);

            public void WriteAllText(string path, string text)
            {
                System.IO.File.WriteAllText(path, text);
            }

            public void WriteAllBytes(string path, byte[] bytes)
            {
                System.IO.File.WriteAllBytes(path, bytes);
            }

            public Stream OpenRead(string path) =>
                System.IO.File.OpenRead(path);

            public byte[] ReadAllBytes(string texturePath) =>
                System.IO.File.ReadAllBytes(texturePath);
        }
    }
}
