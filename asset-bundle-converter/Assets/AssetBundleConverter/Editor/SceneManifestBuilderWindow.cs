using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using UnityEditor;
using UnityEngine;
using Debug = UnityEngine.Debug;

namespace DCL.ABConverter.Editor
{
    /// <summary>
    /// Unity Editor tool that runs the scene-lod-entities-manifest-builder npm process
    /// and imports the generated manifest into the Unity project.
    /// </summary>
    public class SceneManifestBuilderWindow : EditorWindow
    {
        private const string MANIFEST_BUILDER_RELATIVE_PATH = "../scene-lod-entities-manifest-builder";
        private const string OUTPUT_MANIFESTS_FOLDER = "output-manifests";
        private const string SCENE_MANIFEST_FOLDER = "Assets/_SceneManifest";

        private enum InputMode
        {
            Coordinates,
            SceneId,
            LocalPath
        }

        private InputMode inputMode = InputMode.Coordinates;
        private int xCoord = 0;
        private int yCoord = 0;
        private string sceneId = "";
        private string localPath = "";
        private bool overwriteExisting = false;
        private string customOutputDir = "";

        private Vector2 scrollPosition;
        private string lastOutput = "";
        private bool isRunning = false;
        private List<string> importedManifests = new List<string>();

        [MenuItem("Decentraland/Scene Manifest Builder")]
        public static void ShowWindow()
        {
            var window = GetWindow<SceneManifestBuilderWindow>("Scene Manifest Builder");
            window.minSize = new Vector2(500, 450);
            window.Show();
        }

        private void OnGUI()
        {
            GUILayout.Label("Scene LOD Entities Manifest Builder", EditorStyles.boldLabel);
            EditorGUILayout.Space();

            EditorGUILayout.HelpBox(
                "This tool runs the scene-lod-entities-manifest-builder npm process to generate " +
                "a manifest JSON file for a Decentraland scene, then imports it into the Unity project.",
                MessageType.Info);

            EditorGUILayout.Space();

            // Input mode selection
            EditorGUILayout.LabelField("Input Mode", EditorStyles.boldLabel);
            inputMode = (InputMode)EditorGUILayout.EnumPopup("Mode:", inputMode);

            EditorGUILayout.Space();

            // Mode-specific input
            switch (inputMode)
            {
                case InputMode.Coordinates:
                    RenderCoordinatesInput();
                    break;
                case InputMode.SceneId:
                    RenderSceneIdInput();
                    break;
                case InputMode.LocalPath:
                    RenderLocalPathInput();
                    break;
            }

            EditorGUILayout.Space();

            // Options
            EditorGUILayout.LabelField("Options", EditorStyles.boldLabel);
            overwriteExisting = EditorGUILayout.Toggle("Overwrite Existing", overwriteExisting);
            
            EditorGUILayout.BeginHorizontal();
            EditorGUILayout.LabelField("Custom Output Dir:", GUILayout.Width(130));
            customOutputDir = EditorGUILayout.TextField(customOutputDir);
            EditorGUILayout.EndHorizontal();
            EditorGUILayout.HelpBox("Leave empty to use default output-manifests folder", MessageType.None);

            EditorGUILayout.Space();

            // Run button
            GUI.enabled = !isRunning && IsInputValid();
            if (GUILayout.Button(isRunning ? "Running..." : "Generate & Import Manifest", GUILayout.Height(35)))
            {
                RunManifestBuilder();
            }
            GUI.enabled = true;

            EditorGUILayout.Space();

            // Imported manifests
            if (importedManifests.Count > 0)
            {
                EditorGUILayout.LabelField("Recently Imported:", EditorStyles.boldLabel);
                foreach (var manifest in importedManifests.TakeLast(5))
                {
                    EditorGUILayout.LabelField($"  • {Path.GetFileName(manifest)}", EditorStyles.miniLabel);
                }
            }

            EditorGUILayout.Space();

            // Output log
            if (!string.IsNullOrEmpty(lastOutput))
            {
                EditorGUILayout.LabelField("Process Output:", EditorStyles.boldLabel);
                scrollPosition = EditorGUILayout.BeginScrollView(scrollPosition, GUILayout.Height(150));
                EditorGUILayout.TextArea(lastOutput, GUILayout.ExpandHeight(true));
                EditorGUILayout.EndScrollView();
            }

            // Quick actions
            EditorGUILayout.Space();
            EditorGUILayout.BeginHorizontal();
            if (GUILayout.Button("Open _SceneManifest Folder"))
            {
                EnsureSceneManifestFolderExists();
                EditorUtility.RevealInFinder(SCENE_MANIFEST_FOLDER);
            }
            if (GUILayout.Button("Refresh Manifests List"))
            {
                RefreshManifestsList();
            }
            EditorGUILayout.EndHorizontal();
        }

        private void RenderCoordinatesInput()
        {
            EditorGUILayout.BeginHorizontal();
            EditorGUILayout.LabelField("Coordinates:", GUILayout.Width(100));
            xCoord = EditorGUILayout.IntField("X", xCoord);
            yCoord = EditorGUILayout.IntField("Y", yCoord);
            EditorGUILayout.EndHorizontal();
        }

        private void RenderSceneIdInput()
        {
            EditorGUILayout.BeginHorizontal();
            EditorGUILayout.LabelField("Scene ID:", GUILayout.Width(100));
            sceneId = EditorGUILayout.TextField(sceneId);
            EditorGUILayout.EndHorizontal();
            EditorGUILayout.HelpBox("Enter the scene's content hash/ID (e.g., bafkrei...)", MessageType.None);
        }

        private void RenderLocalPathInput()
        {
            EditorGUILayout.BeginHorizontal();
            EditorGUILayout.LabelField("Local Path:", GUILayout.Width(100));
            localPath = EditorGUILayout.TextField(localPath);
            if (GUILayout.Button("Browse", GUILayout.Width(60)))
            {
                string path = EditorUtility.OpenFilePanel("Select Scene File", "", "js");
                if (!string.IsNullOrEmpty(path))
                {
                    localPath = path;
                }
            }
            EditorGUILayout.EndHorizontal();
            EditorGUILayout.HelpBox("Path to local scene file (e.g., ../my-scene/bin/index.js)", MessageType.None);
        }

        private bool IsInputValid()
        {
            return inputMode switch
            {
                InputMode.Coordinates => true, // Coordinates are always valid (can be any integer)
                InputMode.SceneId => !string.IsNullOrWhiteSpace(sceneId),
                InputMode.LocalPath => !string.IsNullOrWhiteSpace(localPath),
                _ => false
            };
        }

        private void RunManifestBuilder()
        {
            isRunning = true;
            lastOutput = "";

            try
            {
                string manifestBuilderPath = GetManifestBuilderPath();
                
                if (!Directory.Exists(manifestBuilderPath))
                {
                    string error = $"Manifest builder folder not found at: {manifestBuilderPath}";
                    Debug.LogError(error);
                    EditorUtility.DisplayDialog("Error", error, "OK");
                    lastOutput = error;
                    isRunning = false;
                    return;
                }

                // Get list of existing manifests before running
                string outputPath = GetOutputManifestsPath(manifestBuilderPath);
                var existingManifests = GetExistingManifests(outputPath);

                // Build npm command arguments
                string arguments = BuildNpmArguments();

                Debug.Log($"Running: npm run start {arguments}");
                Debug.Log($"Working Directory: {manifestBuilderPath}");

                EditorUtility.DisplayProgressBar("Scene Manifest Builder", "Running npm process...", 0.3f);

                // Run npm process
                var result = RunNpmProcess(manifestBuilderPath, arguments);
                lastOutput = result.output;

                if (result.exitCode == 0)
                {
                    EditorUtility.DisplayProgressBar("Scene Manifest Builder", "Importing manifest...", 0.7f);
                    
                    // Find and import new manifests
                    var newManifests = FindNewManifests(outputPath, existingManifests);
                    
                    if (newManifests.Count > 0)
                    {
                        ImportManifests(newManifests);
                        
                        string successMessage = $"Successfully generated and imported {newManifests.Count} manifest(s):\n" +
                                               string.Join("\n", newManifests.Select(Path.GetFileName));
                        Debug.Log(successMessage);
                        EditorUtility.DisplayDialog("Success", successMessage, "OK");
                    }
                    else
                    {
                        // Check if manifest already existed (no new file because overwrite wasn't set)
                        string message = "No new manifests were generated. The manifest may already exist.\n" +
                                        "Enable 'Overwrite Existing' to regenerate.";
                        Debug.LogWarning(message);
                        EditorUtility.DisplayDialog("Info", message, "OK");
                    }
                }
                else
                {
                    string errorMessage = $"npm process failed with exit code {result.exitCode}\n\n{result.output}";
                    Debug.LogError(errorMessage);
                    EditorUtility.DisplayDialog("Error", "npm process failed. Check the console for details.", "OK");
                }
            }
            catch (Exception e)
            {
                string errorMessage = $"Error running manifest builder: {e.Message}\n{e.StackTrace}";
                Debug.LogError(errorMessage);
                EditorUtility.DisplayDialog("Error", $"Error: {e.Message}", "OK");
                lastOutput = errorMessage;
            }
            finally
            {
                EditorUtility.ClearProgressBar();
                isRunning = false;
                Repaint();
            }
        }

        private string GetManifestBuilderPath()
        {
            // Get the path relative to the Unity project
            string projectPath = Path.GetDirectoryName(Application.dataPath);
            return Path.GetFullPath(Path.Combine(projectPath, MANIFEST_BUILDER_RELATIVE_PATH));
        }

        private string GetOutputManifestsPath(string manifestBuilderPath)
        {
            if (!string.IsNullOrWhiteSpace(customOutputDir))
            {
                return Path.Combine(manifestBuilderPath, customOutputDir);
            }
            return Path.Combine(manifestBuilderPath, OUTPUT_MANIFESTS_FOLDER);
        }

        private string BuildNpmArguments()
        {
            var args = new List<string>();

            switch (inputMode)
            {
                case InputMode.Coordinates:
                    args.Add($"--coords={xCoord},{yCoord}");
                    break;
                case InputMode.SceneId:
                    args.Add($"--sceneid={sceneId}");
                    break;
                case InputMode.LocalPath:
                    args.Add($"--path=\"{localPath}\"");
                    break;
            }

            if (overwriteExisting)
            {
                args.Add("--overwrite");
            }

            if (!string.IsNullOrWhiteSpace(customOutputDir))
            {
                args.Add($"--output={customOutputDir}");
            }

            return string.Join(" ", args);
        }

        private HashSet<string> GetExistingManifests(string outputPath)
        {
            var manifests = new HashSet<string>();
            
            if (Directory.Exists(outputPath))
            {
                foreach (var file in Directory.GetFiles(outputPath, "*-lod-manifest.json"))
                {
                    manifests.Add(Path.GetFileName(file));
                }
            }
            
            return manifests;
        }

        private List<string> FindNewManifests(string outputPath, HashSet<string> existingManifests)
        {
            var newManifests = new List<string>();
            
            if (!Directory.Exists(outputPath))
            {
                return newManifests;
            }

            foreach (var file in Directory.GetFiles(outputPath, "*-lod-manifest.json"))
            {
                string fileName = Path.GetFileName(file);
                
                // If overwrite is enabled, include files that were modified recently
                if (overwriteExisting)
                {
                    var fileInfo = new FileInfo(file);
                    if (fileInfo.LastWriteTime > DateTime.Now.AddMinutes(-5))
                    {
                        newManifests.Add(file);
                    }
                }
                else if (!existingManifests.Contains(fileName))
                {
                    newManifests.Add(file);
                }
            }
            
            return newManifests;
        }

        private void ImportManifests(List<string> manifestPaths)
        {
            EnsureSceneManifestFolderExists();

            foreach (var sourcePath in manifestPaths)
            {
                string fileName = Path.GetFileName(sourcePath);
                string destPath = Path.Combine(SCENE_MANIFEST_FOLDER, fileName);

                try
                {
                    File.Copy(sourcePath, destPath, true);
                    Debug.Log($"Imported manifest: {fileName} -> {destPath}");
                    importedManifests.Add(destPath);
                }
                catch (Exception e)
                {
                    Debug.LogError($"Failed to copy manifest {fileName}: {e.Message}");
                }
            }

            // Refresh asset database to show new files
            AssetDatabase.Refresh();
        }

        private void EnsureSceneManifestFolderExists()
        {
            if (!Directory.Exists(SCENE_MANIFEST_FOLDER))
            {
                Directory.CreateDirectory(SCENE_MANIFEST_FOLDER);
                AssetDatabase.Refresh();
            }
        }

        private void RefreshManifestsList()
        {
            importedManifests.Clear();
            
            if (Directory.Exists(SCENE_MANIFEST_FOLDER))
            {
                var manifests = Directory.GetFiles(SCENE_MANIFEST_FOLDER, "*-lod-manifest.json");
                importedManifests.AddRange(manifests);
            }
            
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
                    // On Windows, use cmd.exe to run npm
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
                    // On macOS/Linux, use the user's shell to ensure PATH is set correctly
                    string shell = Environment.GetEnvironmentVariable("SHELL") ?? "/bin/zsh";
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
                        {
                            output.AppendLine(e.Data);
                            Debug.Log($"[npm] {e.Data}");
                        }
                    };

                    process.ErrorDataReceived += (sender, e) =>
                    {
                        if (!string.IsNullOrEmpty(e.Data))
                        {
                            output.AppendLine($"[ERROR] {e.Data}");
                            Debug.LogWarning($"[npm error] {e.Data}");
                        }
                    };

                    process.Start();
                    process.BeginOutputReadLine();
                    process.BeginErrorReadLine();

                    // Wait with timeout (2 minutes)
                    bool completed = process.WaitForExit(120000);
                    
                    if (!completed)
                    {
                        process.Kill();
                        output.AppendLine("\n[TIMEOUT] Process was killed after 2 minutes");
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
    }
}

