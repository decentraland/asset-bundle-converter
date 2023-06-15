using AssetBundleConverter.Wrappers.Interfaces;
using DCL;
using DCL.ABConverter;
using System;
using System.Collections.Generic;
using System.Threading.Tasks;
using UnityEditor;
using UnityEditor.Compilation;
using UnityEditor.SceneManagement;
using UnityEngine;

namespace AssetBundleConverter.Wrappers.Implementations.Default
{
    public class AssetBundleEditor : IEditor
    {
        private const string VISUAL_TEST_SCENE = "Assets/AssetBundleConverter/VisualTestScene.unity";

        public void DisplayProgressBar(string title, string body, float progress)
        {
#if UNITY_EDITOR
            EditorUtility.DisplayProgressBar(title, body, progress);
#endif
        }

        public void ClearProgressBar()
        {
#if UNITY_EDITOR
            EditorUtility.ClearProgressBar();
#endif
        }

        public void Exit(int errorCode)
        {
            Utils.Exit(errorCode);
        }

        public async Task LoadVisualTestSceneAsync()
        {
            var scene = EditorSceneManager.OpenScene(VISUAL_TEST_SCENE, OpenSceneMode.Single);
            await WaitUntilAsync(() => scene.isLoaded);
        }

        public async Task TestConvertedAssetsAsync(Environment env, ClientSettings settings, List<AssetPath> assetsToMark, IErrorReporter errorReporter)
        {
            await VisualTests.TestConvertedAssetsAsync(env,settings,assetsToMark,errorReporter);
        }

        public Task Delay(TimeSpan time) =>
            Task.Delay(time);

        public bool SwitchBuildTarget(BuildTarget targetPlatform)
        {
            if (EditorUserBuildSettings.activeBuildTarget == targetPlatform)
                return true;

            if (!Application.isBatchMode && !IsBuildTargetSupported(targetPlatform))
            {
                Debug.LogError($"Build target {targetPlatform} is not installed!");
                return false;
            }

            Debug.Log("Build target is: " + targetPlatform);
            switch (targetPlatform)
            {
                case BuildTarget.StandaloneWindows64 or BuildTarget.StandaloneOSX:
                    EditorUserBuildSettings.SwitchActiveBuildTarget(BuildTargetGroup.Standalone, targetPlatform);
                    return true;
                case BuildTarget.WebGL:
                    EditorUserBuildSettings.SwitchActiveBuildTarget(BuildTargetGroup.WebGL, BuildTarget.WebGL);
                    return true;
            }

            throw new Exception($"Build target {targetPlatform} is not supported");
        }

        private bool IsBuildTargetSupported(BuildTarget target)
        {
            var moduleManager = System.Type.GetType("UnityEditor.Modules.ModuleManager,UnityEditor.dll");
            var isPlatformSupportLoaded = moduleManager.GetMethod("IsPlatformSupportLoaded", System.Reflection.BindingFlags.Static | System.Reflection.BindingFlags.NonPublic);
            var getTargetStringFromBuildTarget = moduleManager.GetMethod("GetTargetStringFromBuildTarget", System.Reflection.BindingFlags.Static | System.Reflection.BindingFlags.NonPublic);

            return (bool)isPlatformSupportLoaded.Invoke(null,new object[] {(string)getTargetStringFromBuildTarget.Invoke(null, new object[] {target})});
        }

        private static async Task WaitUntilAsync(Func<bool> predicate, int sleep = 50)
        {
            while (!predicate())
                await Task.Delay(sleep);
        }
    }
}
