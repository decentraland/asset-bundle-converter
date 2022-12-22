using System.IO;
using System.Linq;

namespace DCL.ABConverter
{
    public class AssetPath
    {
        public readonly string basePath;
        public readonly ContentServerUtils.MappingPair pair;
        public string hash => pair.hash;
        public string filePath => pair.file;
        public readonly string fileName;
        public readonly string hashPath;

        public AssetPath(string basePath, string hash, string file)
        {
            this.basePath = basePath;
            pair = new ContentServerUtils.MappingPair { hash = hash, file = file };
        }

        public AssetPath(string basePath, ContentServerUtils.MappingPair pair)
        {
            this.basePath = basePath;
            this.pair = pair;
            string normalizedString = filePath.Replace('\\', '/');
            this.fileName = normalizedString.Substring(normalizedString.LastIndexOf('/') + 1);

            var fileExtension = fileName.Split('.').Last();
            var normalizedFilePath = filePath.Replace("\\", "/");
            var split = normalizedFilePath.Split("/").ToList();
            split.RemoveAt(split.Count-1);
            var fileRootPath = string.Join('/', split);
            this.hashPath = fileRootPath + "/" + hash + "." + fileExtension;
        }

        public string finalPath
        {
            get
            {
                string fileExt = Path.GetExtension(pair.file);
                return assetFolder + pair.hash + fileExt;
            }
        }

        public string assetFolder
        {
            get
            {
                char dash = Path.DirectorySeparatorChar;
                return basePath + pair.hash + dash;
            }
        }

        public string finalMetaPath => Path.ChangeExtension(finalPath, "meta");

        public override string ToString()
        {
            return $"hash: {hash} - file: {filePath}";
        }
    }
}
