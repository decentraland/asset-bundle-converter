using System.IO;

namespace DCL.ABConverter
{
    public class AssetPath
    {
        public readonly string basePath;
        public readonly ContentServerUtils.MappingPair pair;
        public string hash => pair.hash;
        public string file => pair.file;

        public AssetPath(string basePath, string hash, string file)
        {
            this.basePath = basePath;
            pair = new ContentServerUtils.MappingPair { hash = hash, file = file };
        }

        public AssetPath(string basePath, ContentServerUtils.MappingPair pair)
        {
            this.basePath = basePath;
            this.pair = pair;
        }

        public string finalPath
        {
            get
            {
                char dash = Path.DirectorySeparatorChar;
                string fileExt = Path.GetExtension(pair.file);
                return basePath + pair.hash + dash + pair.hash + fileExt;
            }
        }

        public string finalMetaPath => Path.ChangeExtension(finalPath, "meta");

        public override string ToString() { return $"hash:{hash} - file:{file}"; }
    }
}