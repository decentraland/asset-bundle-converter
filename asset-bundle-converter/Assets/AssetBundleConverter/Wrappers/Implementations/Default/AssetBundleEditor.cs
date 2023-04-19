using DCL;
using UnityEditor;

namespace AssetBundleConverter.Wrappers.Implementations.Default
{
    public class AssetBundleEditor : IEditor
    {
        public void DisplayProgressBar(string title, string body, float progress)
        {
            EditorUtility.DisplayProgressBar(title, body, progress);
        }

        public void ClearProgressBar()
        {
            EditorUtility.ClearProgressBar();
        }
    }
}
