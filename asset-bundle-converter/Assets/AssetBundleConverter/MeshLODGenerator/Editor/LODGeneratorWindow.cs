using AssetBundleConverter;
using AssetBundleConverter.Wrappers.Implementations.Default;
using AssetBundleConverter.Wrappers.Interfaces;
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Threading.Tasks;
using Cysharp.Threading.Tasks;
using DCL;
using DCL.ABConverter;
using GLTFast.Export;
using GLTFast.Logging;
using UnityEditor;
using UnityEngine;
using Debug = UnityEngine.Debug;
using Environment = AssetBundleConverter.Environment;
using SystemFile = AssetBundleConverter.Wrappers.Implementations.Default.SystemWrappers.File;

namespace DCL.ABConverter.Editor
{
    /// <summary>
    /// Editor window that takes a Decentraland scene pointer (coordinates),
    /// generates the scene manifest, downloads and imports all scene assets via
    /// the existing AssetBundleConverter pipeline, instances ISS assets in the Unity scene,
    /// and exports the result as a GLB file.
    /// </summary>
    public class LODGeneratorWindow : EditorWindow
    {
        private const string MANIFEST_BUILDER_RELATIVE_PATH = "../scene-lod-entities-manifest-builder";
        private const string OUTPUT_MANIFESTS_FOLDER = "output-manifests";
        private const string SCENE_MANIFEST_FOLDER = "Assets/_SceneManifest";
        private const string EXPORTED_FOLDER = "Assets/_ExportedLODs";
        private const string DEFAULT_CATALYST_URL = "https://peer.decentraland.org";

        private int xCoord = 0;
        private int yCoord = 0;
        private string catalystUrl = DEFAULT_CATALYST_URL;
        private bool cleanDownloadedFolder = true;

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
                "2. Download, import, and instance ISS assets\n" +
                "3. Export the scene as a GLB file",
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

            cleanDownloadedFolder = EditorGUILayout.Toggle("Clean _Downloaded before run", cleanDownloadedFolder);

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
                // Clean _Downloaded folder before starting
                if (cleanDownloadedFolder && Directory.Exists("Assets/_Downloaded"))
                {
                    Log("Cleaning _Downloaded folder...");
                    Directory.Delete("Assets/_Downloaded", true);
                    AssetDatabase.Refresh();
                    Log("_Downloaded folder deleted.");
                }

                // Step 1: Generate the scene manifest
                Log("=== Step 1/3: Generating Scene Manifest ===");
                EditorUtility.DisplayProgressBar("LOD Generator", "Generating scene manifest...", 0.1f);

                string sceneId = await GenerateManifest();
                if (string.IsNullOrEmpty(sceneId))
                {
                    Log("ERROR: Failed to generate manifest. Aborting.");
                    return;
                }

                currentSceneId = sceneId;
                Log($"Manifest generated for scene: {sceneId}");

                // Step 2: Run the AssetBundleConverter pipeline (download, import, instance ISS assets)
                Log("\n=== Step 2/3: Running AssetBundleConverter ===");
                EditorUtility.DisplayProgressBar("LOD Generator", "Running asset conversion...", 0.3f);

                await RunAssetBundleConverter();

                Log("AssetBundleConverter finished.");

                // Step 3: Export instanced scene to GLB
                Log("\n=== Step 3/3: Exporting scene to GLB ===");
                EditorUtility.DisplayProgressBar("LOD Generator", "Exporting GLB...", 0.8f);

                string exportPath = await ExportSceneToGlb(sceneId);

                Log("\n=== LOD Generation Complete ===");
                string message = $"LOD generation complete for pointer ({xCoord},{yCoord}).\nScene ID: {sceneId}";
                if (!string.IsNullOrEmpty(exportPath))
                    message += $"\nExported to: {exportPath}";
                EditorUtility.DisplayDialog("LOD Generator", message, "OK");
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

            string outputPath = Path.Combine(manifestBuilderPath, OUTPUT_MANIFESTS_FOLDER);
            CleanFolder(outputPath);

            string arguments = $"--catalyst={catalystUrl} --coords={xCoord},{yCoord} --overwrite";
            Log($"Running: npm run start {arguments}");

            var result = RunNpmProcess(manifestBuilderPath, arguments);
            Log(result.output);

            if (result.exitCode != 0)
            {
                Log($"npm process failed with exit code {result.exitCode}");
                return null;
            }

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
        /// Runs the full AssetBundleConverter pipeline via SceneClient.ConvertEntityByPointer.
        ///
        /// Key points:
        /// - We inject a custom Environment with a NoSceneLoadEditor to prevent
        ///   ConvertAsync from replacing the current scene with VisualTestScene.
        /// - placeOnScene = true triggers the ISS placement path in ProcessAllGltfs,
        ///   which uses PlaceAssetFromManifest (ISS-only, at ISS positions).
        /// - createAssetBundle = false skips asset bundle building.
        /// </summary>
        private async UniTask RunAssetBundleConverter()
        {
            var settings = new ClientSettings
            {
                targetPointer = new Vector2Int(xCoord, yCoord),
                baseUrl = catalystUrl + "/content/contents/",
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

            // Inject a custom Environment that does NOT load the visual test scene
            SceneClient.env = CreateEnvironmentWithNoSceneLoad(settings.BuildPipelineType);

            Log($"Running AssetBundleConverter for pointer ({xCoord},{yCoord})...");

            var conversionState = await SceneClient.ConvertEntityByPointer(settings);

            Log($"Conversion finished. State: {conversionState.step}");

            if (conversionState.lastErrorCode != ErrorCodes.SUCCESS)
            {
                Log($"WARNING: Conversion reported error code: {conversionState.lastErrorCode}");
            }
        }

        /// <summary>
        /// Creates an Environment identical to the default, except the IEditor
        /// does NOT open the VisualTestScene (which would destroy the current scene).
        /// </summary>
        private static Environment CreateEnvironmentWithNoSceneLoad(BuildPipelineType buildPipelineType)
        {
            var database = new UnityEditorWrappers.AssetDatabase();

            IBuildPipeline pipeline =
                buildPipelineType == BuildPipelineType.Scriptable
                    ? new ScriptableBuildPipeline()
                    : (IBuildPipeline)new UnityEditorWrappers.BuildPipeline();

            return new Environment(
                directory: new DCL.SystemWrappers.Directory(),
                file: new SystemFile(),
                assetDatabase: database,
                webRequest: new UnityEditorWrappers.WebRequest(),
                buildPipeline: pipeline,
                gltfImporter: new DefaultGltfImporter(database),
                editor: new NoSceneLoadEditor(),
                logger: new ABLogger("[LODGenerator]"),
                errorReporter: new ErrorReporter(),
                buildPipelineType: buildPipelineType
            );
        }

        #endregion

        #region Step 3: Export GLB

        /// <summary>
        /// Collects all root GameObjects in the scene (excluding cameras and lights),
        /// disables SkinnedMeshRenderers to avoid bone/joint export issues,
        /// and exports as a single GLB file using glTFast's GameObjectExport.
        /// </summary>
        private async UniTask<string> ExportSceneToGlb(string sceneId)
        {
            // Collect all root GameObjects that were instanced (skip cameras/lights)
            var rootObjects = new List<GameObject>();
            var allRootObjects = UnityEngine.SceneManagement.SceneManager.GetActiveScene().GetRootGameObjects();

            foreach (var go in allRootObjects)
            {
                if (go.GetComponent<Camera>() != null || go.GetComponent<Light>() != null)
                    continue;

                rootObjects.Add(go);
            }

            if (rootObjects.Count == 0)
            {
                Log("WARNING: No objects found in scene to export.");
                return null;
            }

            Log($"Exporting {rootObjects.Count} root object(s) to GLB...");

            // Disable SkinnedMeshRenderers before export to avoid bone/joints issues
            var disabledSkinned = new List<SkinnedMeshRenderer>();
            foreach (var go in rootObjects)
            {
                foreach (var smr in go.GetComponentsInChildren<SkinnedMeshRenderer>(true))
                {
                    if (smr.enabled)
                    {
                        smr.enabled = false;
                        disabledSkinned.Add(smr);
                    }
                }
            }

            if (disabledSkinned.Count > 0)
                Log($"Disabled {disabledSkinned.Count} SkinnedMeshRenderer(s) before export.");

            EnsureFolderExists(EXPORTED_FOLDER);

            string exportFileName = $"{sceneId}_scene.glb";
            string exportPath = Path.Combine(EXPORTED_FOLDER, exportFileName);
            string fullExportPath = Path.GetFullPath(exportPath);

            var exportSettings = new ExportSettings
            {
                Format = GltfFormat.Binary,
                FileConflictResolution = FileConflictResolution.Overwrite,
            };

            var gameObjectExportSettings = new GameObjectExportSettings
            {
                OnlyActiveInHierarchy = true,
            };

            var export = new GameObjectExport(exportSettings, gameObjectExportSettings: gameObjectExportSettings, logger: new ConsoleLogger());
            export.AddScene(rootObjects.ToArray(), sceneId);

            bool success = await export.SaveToFileAndDispose(fullExportPath);

            // Re-enable SkinnedMeshRenderers
            foreach (var smr in disabledSkinned)
            {
                if (smr != null)
                    smr.enabled = true;
            }

            if (success)
            {
                Log($"GLB exported to: {exportPath}");
                AssetDatabase.Refresh();
                return exportPath;
            }
            else
            {
                Log("ERROR: GLB export failed.");
                return null;
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

    /// <summary>
    /// IEditor implementation that delegates everything to AssetBundleEditor
    /// except LoadVisualTestSceneAsync, which is a no-op.
    /// This prevents the AssetBundleConverter from replacing the current scene.
    /// </summary>
    internal class NoSceneLoadEditor : IEditor
    {
        private readonly AssetBundleEditor inner = new();

        public void DisplayProgressBar(string title, string body, float progress) =>
            inner.DisplayProgressBar(title, body, progress);

        public void ClearProgressBar() =>
            inner.ClearProgressBar();

        public void Exit(int errorCode) =>
            inner.Exit(errorCode);

        public Task LoadVisualTestSceneAsync() =>
            Task.CompletedTask; // No-op: keep the current scene

        public Task TestConvertedAssetsAsync(Environment env, ClientSettings settings, List<AssetPath> assetsToMark, IErrorReporter errorReporter) =>
            Task.CompletedTask; // No-op: skip visual tests

        public Task Delay(TimeSpan time) =>
            inner.Delay(time);

        public bool SwitchBuildTarget(BuildTarget targetPlatform) =>
            inner.SwitchBuildTarget(targetPlatform);
    }
}
