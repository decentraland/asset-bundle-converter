// unset:none
using System;

namespace AssetBundleConverter.LODs.JsonParsing
{
    [Serializable]
    public class GLTFContainerData : ComponentData
    {
        public DCLGLTFMesh mesh;

        public GLTFContainerData(DCLGLTFMesh mesh)
        {
            this.mesh = mesh;
        }

    }
}
