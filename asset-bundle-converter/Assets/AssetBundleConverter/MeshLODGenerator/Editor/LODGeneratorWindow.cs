using AssetBundleConverter;
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using Cysharp.Threading.Tasks;
using DCL;
using DCL.ABConverter;
using Newtonsoft.Json;
using UnityEditor;
using UnityEngine;
using UnityEngine.Networking;
using Debug = UnityEngine.Debug;
using Environment = AssetBundleConverter.Environment;

namespace DCL.ABConverter.Editor
{
    /// <summary>
    /// Editor window that takes a Decentraland scene pointer (coordinates),
    /// generates the scene manifest, downloads and imports all scene assets via
    /// the existing AssetBundleConverter pipeline, and instances them in the Unity scene.
    /// </summary>
    public class LODGeneratorWindow : EditorWindow
    {
        private const string MANIFEST_BUILDER_RELATIVE_PATH = "../scene-lod-entities-manifest-builder";
        private const string OUTPUT_MANIFESTS_FOLDER = "output-manifests";
        private const string SCENE_MANIFEST_FOLDER = "Assets/_SceneManifest";
        private const string DEFAULT_CATALYST_URL = "https://peer.decentraland.org";

        private int xCoord = 0;
        private int yCoord = 0;
        private string catalystUrl = DEFAULT_CATALYST_URL;

        private Vector2 scrollPosition;
        private string processLog = "";
        private bool isRunning = false;

        private string currentSceneId = "";

        [MenuItem("Decentraland/LOD Generator")]
        public static void ShowWindow()
        {
            var window = GetWindow<LODGeneratorWindow>("LOD Generator");
            window.minSize = new Vector2(500, 500);
            window.Show();
        }

        private void OnGUI()
        {
            GUILayout.Label("LOD Generator", EditorStyles.boldLabel);
            EditorGUILayout.Space();

            EditorGUILayout.HelpBox(
                "Enter a scene pointer (parcel coordinates) to:\n" +
                "1. Generate the scene manifest\n" +
                "2. Download and import all scene assets\n" +
                "3. Instance them in the Unity scene",
                MessageType.Info);

            EditorGUILayout.Space();

            // Pointer input
            EditorGUILayout.LabelField("Scene Pointer", EditorStyles.boldLabel);
            EditorGUILayout.BeginHorizontal();
            EditorGUILayout.LabelField("Coordinates:", GUILayout.Width(100));
            xCoord = EditorGUILayout.IntField("X", xCoord);
            yCoord = EditorGUILayout.IntField("Y", yCoord);
            EditorGUILayout.EndHorizontal();

            EditorGUILayout.Space();

            // Options
            EditorGUILayout.LabelField("Options", EditorStyles.boldLabel);
            EditorGUILayout.BeginHorizontal();
            EditorGUILayout.LabelField("Catalyst URL:", GUILayout.Width(130));
            catalystUrl = EditorGUILayout.TextField(catalystUrl);
            if (GUILayout.Button("Reset", GUILayout.Width(50)))
                catalystUrl = DEFAULT_CATALYST_URL;
            EditorGUILayout.EndHorizontal();

            EditorGUILayout.Space();

            // Run button
            GUI.enabled = !isRunning;
            if (GUILayout.Button(isRunning ? "Running..." : "Generate LOD", GUILayout.Height(40)))
            {
                RunFullPipeline();
            }
            GUI.enabled = true;

            EditorGUILayout.Space();

            // Status
            if (!string.IsNullOrEmpty(currentSceneId))
            {
                EditorGUILayout.LabelField($"Scene ID: {currentSceneId}", EditorStyles.miniLabel);
            }

            // Process log
            if (!string.IsNullOrEmpty(processLog))
            {
                EditorGUILayout.LabelField("Log:", EditorStyles.boldLabel);
                scrollPosition = EditorGUILayout.BeginScrollView(scrollPosition, GUILayout.Height(250));
                EditorGUILayout.TextArea(processLog, GUILayout.ExpandHeight(true));
                EditorGUILayout.EndScrollView();
            }
        }

        private async void RunFullPipeline()
        {
            isRunning = true;
            processLog = "";
            currentSceneId = "";

            try
            {
                // Step 1: Generate the scene manifest
                Log("=== Step 1/2: Generating Scene Manifest ===");
                EditorUtility.DisplayProgressBar("LOD Generator", "Generating scene manifest...", 0.1f);

                string sceneId = await GenerateManifest();
                if (string.IsNullOrEmpty(sceneId))
                {
                    Log("ERROR: Failed to generate manifest. Aborting.");
                    return;
                }

                currentSceneId = sceneId;
                Log($"Manifest generated for scene: {sceneId}");

                // Step 2: Use the existing AssetBundleConverter pipeline to download,
                // import, and instance all scene assets
                Log("\n=== Step 2/2: Downloading, Importing & Instancing via AssetBundleConverter ===");
                EditorUtility.DisplayProgressBar("LOD Generator", "Running asset conversion...", 0.3f);

                await RunAssetBundleConverter(sceneId);

                Log("\n=== LOD Generation Complete ===");
                EditorUtility.DisplayDialog("LOD Generator",
                    $"LOD generation complete for pointer ({xCoord},{yCoord}).\nScene ID: {sceneId}", "OK");
            }
            catch (Exception e)
            {
                Log($"\nERROR: {e.Message}\n{e.StackTrace}");
                Debug.LogError($"LOD Generator error: {e.Message}\n{e.StackTrace}");
                EditorUtility.DisplayDialog("LOD Generator Error", e.Message, "OK");
            }
            finally
            {
                EditorUtility.ClearProgressBar();
                isRunning = false;
                Repaint();
            }
        }

        #region Step 1: Generate Manifest

        private async UniTask<string> GenerateManifest()
        {
            string manifestBuilderPath = GetManifestBuilderPath();

            if (!Directory.Exists(manifestBuilderPath))
            {
                Log($"Manifest builder not found at: {manifestBuilderPath}");
                return null;
            }

            // Clean output folder
            string outputPath = Path.Combine(manifestBuilderPath, OUTPUT_MANIFESTS_FOLDER);
            CleanFolder(outputPath);

            // Build and run npm process
            string arguments = $"--catalyst={catalystUrl} --coords={xCoord},{yCoord} --overwrite";
            Log($"Running: npm run start {arguments}");

            var result = RunNpmProcess(manifestBuilderPath, arguments);
            Log(result.output);

            if (result.exitCode != 0)
            {
                Log($"npm process failed with exit code {result.exitCode}");
                return null;
            }

            // Find generated manifest
            if (!Directory.Exists(outputPath))
            {
                Log("Output folder not created by npm process.");
                return null;
            }

            string[] manifestFiles = Directory.GetFiles(outputPath, "*-lod-manifest.json");
            if (manifestFiles.Length == 0)
            {
                Log("No manifest files were generated.");
                return null;
            }

            // Import manifest into Unity project
            EnsureFolderExists(SCENE_MANIFEST_FOLDER);

            string manifestFile = manifestFiles[0];
            string fileName = Path.GetFileName(manifestFile);
            string destPath = Path.Combine(SCENE_MANIFEST_FOLDER, fileName);
            File.Copy(manifestFile, destPath, true);
            AssetDatabase.Refresh();

            Log($"Manifest imported: {fileName}");

            string sceneId = fileName.Replace("-lod-manifest.json", "");
            return sceneId;
        }

        #endregion

        #region Step 2: AssetBundleConverter pipeline

        /// <summary>
        /// Uses SceneClient.ConvertEntityByPointer to run the full ABConverter pipeline:
        /// download, GLTF import (with texture/material extraction), and scene instancing.
        /// We disable asset bundle building and visual tests since we only need the imported assets in-scene.
        /// </summary>
        private async UniTask RunAssetBundleConverter(string sceneId)
        {
            var settings = new ClientSettings
            {
                targetPointer = new Vector2Int(xCoord, yCoord),
                baseUrl = catalystUrl,
                buildTarget = EditorUserBuildSettings.activeBuildTarget,
                BuildPipelineType = EditorUserBuildSettings.activeBuildTarget == BuildTarget.WebGL
                    ? BuildPipelineType.Default
                    : BuildPipelineType.Scriptable,
                createAssetBundle = false,
                visualTest = false,
                cleanAndExitOnFinish = false,
                clearDirectoriesOnStart = true,
                deleteDownloadPathAfterFinished = false,
                placeOnScene = true,
                verbose = true,
                shaderType = ShaderType.Dcl,
                importGltf = true,
            };

            Log($"Running AssetBundleConverter for pointer ({xCoord},{yCoord})...");

            var conversionState = await SceneClient.ConvertEntityByPointer(settings);

            Log($"Conversion finished. State: {conversionState.step}");

            if (conversionState.lastErrorCode != ErrorCodes.SUCCESS)
            {
                Log($"WARNING: Conversion reported error code: {conversionState.lastErrorCode}");
            }
        }

        #endregion

        #region Helpers

        private string GetManifestBuilderPath()
        {
            string projectPath = Path.GetDirectoryName(Application.dataPath);
            return Path.GetFullPath(Path.Combine(projectPath, MANIFEST_BUILDER_RELATIVE_PATH));
        }

        private void CleanFolder(string folderPath)
        {
            if (!Directory.Exists(folderPath))
                return;

            foreach (string file in Directory.GetFiles(folderPath))
                File.Delete(file);

            foreach (string dir in Directory.GetDirectories(folderPath))
                Directory.Delete(dir, true);
        }

        private void EnsureFolderExists(string path)
        {
            if (!Directory.Exists(path))
                Directory.CreateDirectory(path);
        }

        private void Log(string message)
        {
            processLog += message + "\n";
            Debug.Log($"[LOD Generator] {message}");
            Repaint();
        }

        private (int exitCode, string output) RunNpmProcess(string workingDirectory, string arguments)
        {
            var output = new System.Text.StringBuilder();
            int exitCode = -1;

            try
            {
                ProcessStartInfo startInfo;

                if (Application.platform == RuntimePlatform.WindowsEditor)
                {
                    startInfo = new ProcessStartInfo
                    {
                        FileName = "cmd.exe",
                        Arguments = $"/c npm run start {arguments}",
                        WorkingDirectory = workingDirectory,
                        RedirectStandardOutput = true,
                        RedirectStandardError = true,
                        UseShellExecute = false,
                        CreateNoWindow = true
                    };
                }
                else
                {
                    string shell = System.Environment.GetEnvironmentVariable("SHELL") ?? "/bin/zsh";
                    string command = $"cd \"{workingDirectory}\" && npm run start {arguments}";

                    startInfo = new ProcessStartInfo
                    {
                        FileName = shell,
                        Arguments = $"-l -c \"{command.Replace("\"", "\\\"")}\"",
                        WorkingDirectory = workingDirectory,
                        RedirectStandardOutput = true,
                        RedirectStandardError = true,
                        UseShellExecute = false,
                        CreateNoWindow = true
                    };
                }

                using (var process = new Process { StartInfo = startInfo })
                {
                    process.OutputDataReceived += (sender, e) =>
                    {
                        if (!string.IsNullOrEmpty(e.Data))
                            output.AppendLine(e.Data);
                    };

                    process.ErrorDataReceived += (sender, e) =>
                    {
                        if (!string.IsNullOrEmpty(e.Data))
                            output.AppendLine($"[ERROR] {e.Data}");
                    };

                    process.Start();
                    process.BeginOutputReadLine();
                    process.BeginErrorReadLine();

                    bool completed = process.WaitForExit(120000);

                    if (!completed)
                    {
                        process.Kill();
                        output.AppendLine("[TIMEOUT] Process killed after 2 minutes.");
                        return (-1, output.ToString());
                    }

                    exitCode = process.ExitCode;
                }
            }
            catch (Exception e)
            {
                output.AppendLine($"[EXCEPTION] {e.Message}");
                Debug.LogError($"Failed to run npm process: {e.Message}");
            }

            return (exitCode, output.ToString());
        }

        #endregion
    }
}
