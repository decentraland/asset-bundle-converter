﻿using AssetBundleConverter.Wrappers.Interfaces;
using DCL;
using DCL.ABConverter;
using System;
using System.Collections.Generic;
using System.Threading.Tasks;
using UnityEditor;
using UnityEditor.SceneManagement;

namespace AssetBundleConverter.Wrappers.Implementations.Default
{
    public class AssetBundleEditor : IEditor
    {
        private const string VISUAL_TEST_SCENE = "Assets/AssetBundleConverter/VisualTestScene.unity";

        public void DisplayProgressBar(string title, string body, float progress)
        {
            EditorUtility.DisplayProgressBar(title, body, progress);
        }

        public void ClearProgressBar()
        {
            EditorUtility.ClearProgressBar();
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

        private static async Task WaitUntilAsync(Func<bool> predicate, int sleep = 50)
        {
            while (!predicate())
                await Task.Delay(sleep);
        }
    }
}