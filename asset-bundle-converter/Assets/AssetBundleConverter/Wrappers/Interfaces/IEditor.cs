// unset:none
using AssetBundleConverter;
using AssetBundleConverter.Wrappers.Interfaces;
using DCL.ABConverter;
using System;
using System.Collections.Generic;
using System.Threading.Tasks;
using UnityEditor;
using Environment = AssetBundleConverter.Environment;

namespace DCL
{
    public interface IEditor
    {
        public void DisplayProgressBar(string title, string body, float progress);

        void ClearProgressBar();

        void Exit(int errorCode);

        Task LoadVisualTestSceneAsync();

        Task TestConvertedAssetsAsync(Environment env, ClientSettings settings, List<AssetPath> assetsToMark, IErrorReporter errorReporter);

        Task Delay(TimeSpan time);

        bool SwitchBuildTarget(BuildTarget targetPlatform);
    }
}
