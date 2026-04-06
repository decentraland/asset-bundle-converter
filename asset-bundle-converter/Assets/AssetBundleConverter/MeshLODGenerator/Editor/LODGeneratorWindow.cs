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
using GLTFast;
using GLTFast.Export;
using GLTFast.Logging;
using UnityEditor;
using UnityEngine;
using DigitalOpus.MB.Core;
using DigitalOpus.MB.MBEditor; // for MB3_EditorMethods
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
        private const string DEFAULT_CATALYST_URL = "https://peer.decentraland.zone";

        private int xCoord = 20;
        private int yCoord = 4;
        private string catalystUrl = DEFAULT_CATALYST_URL;
        private bool cleanBeforeRun = true;

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
                "3. Export the scene as a GLB file\n" +
                "4. Run gltfpack to decimate\n" +
                "5. Import decimated GLB & MeshBaker (atlas + combine) → prefab",
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

            cleanBeforeRun = EditorGUILayout.Toggle("Clean folders before run", cleanBeforeRun);

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
                // Clean all working folders before starting
                if (cleanBeforeRun)
                {
                    Log("Cleaning folders...");

                    string[] foldersToClean = { "Assets/_Downloaded", SCENE_MANIFEST_FOLDER, EXPORTED_FOLDER };

                    foreach (string folder in foldersToClean)
                    {
                        if (Directory.Exists(folder))
                        {
                            Directory.Delete(folder, true);
                            // Delete the .meta file too so Unity doesn't get confused
                            string metaFile = folder + ".meta";
                            if (File.Exists(metaFile))
                                File.Delete(metaFile);

                            Log($"  Deleted: {folder}");
                        }
                    }

                    AssetDatabase.Refresh();

                    // Clear scene objects to prevent material leaks from previous runs
                    ClearSceneObjects();
                }

                // Step 1: Generate the scene manifest
                Log("=== Step 1/5: Generating Scene Manifest ===");
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
                Log("\n=== Step 2/5: Running AssetBundleConverter ===");
                EditorUtility.DisplayProgressBar("LOD Generator", "Running asset conversion...", 0.2f);

                await RunAssetBundleConverter();

                Log("AssetBundleConverter finished.");

                // Step 3: Export instanced scene to GLB
                Log("\n=== Step 3/5: Exporting scene to GLB ===");
                EditorUtility.DisplayProgressBar("LOD Generator", "Exporting GLB...", 0.4f);

                string exportPath = await ExportSceneToGlb(sceneId);

                if (string.IsNullOrEmpty(exportPath))
                {
                    Log("ERROR: GLB export failed. Aborting.");
                    return;
                }

                // Step 4: Run gltfpack to decimate
                Log("\n=== Step 4/5: Running gltfpack (decimate to 10%) ===");
                EditorUtility.DisplayProgressBar("LOD Generator", "Running gltfpack decimation...", 0.55f);

                string decimatedPath = RunGltfpack(exportPath, sceneId);

                if (string.IsNullOrEmpty(decimatedPath))
                {
                    Log("ERROR: gltfpack decimation failed. Aborting.");
                    return;
                }

                // Step 5: Import decimated GLB back and run MeshBaker
                Log("\n=== Step 5/5: MeshBaker (atlas + combine → prefab) ===");
                EditorUtility.DisplayProgressBar("LOD Generator", "Importing decimated GLB...", 0.7f);

                // Clear the scene of original objects
                ClearSceneObjects();

                // Import the decimated GLB into the scene
                await ImportGlbIntoScene(decimatedPath);

                Log("Running MeshBaker on decimated mesh...");
                EditorUtility.DisplayProgressBar("LOD Generator", "Baking textures & combining meshes...", 0.8f);

                string prefabPath = RunMeshBaker(sceneId);

                Log("\n=== LOD Generation Complete ===");
                string message = $"LOD generation complete for pointer ({xCoord},{yCoord}).\nScene ID: {sceneId}";
                if (!string.IsNullOrEmpty(exportPath))
                    message += $"\nOriginal GLB: {exportPath}";
                if (!string.IsNullOrEmpty(decimatedPath))
                    message += $"\nDecimated GLB: {decimatedPath}";
                if (!string.IsNullOrEmpty(prefabPath))
                    message += $"\nCombined prefab: {prefabPath}";
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

        #region Step 5: MeshBaker (texture atlas + mesh combine → prefab)

        /// <summary>
        /// Uses MeshBaker to bake all scene textures into a single atlas
        /// and combine all meshes into a single prefab with one material.
        /// Mirrors the MeshBaker editor workflow:
        ///   1. "Create Empty Assets" → material + TextureBakeResults on disk
        ///   2. "Bake Materials" → CreateAtlases populates those assets
        ///   3. "Bake" (BakeIntoCombined with bakeIntoPrefab)
        /// </summary>
        private string RunMeshBaker(string sceneId)
        {
            // Collect all GameObjects with renderers (skip cameras/lights)
            var objectsToCombine = new List<GameObject>();
            var allRootObjects = UnityEngine.SceneManagement.SceneManager.GetActiveScene().GetRootGameObjects();

            foreach (var root in allRootObjects)
            {
                if (root.GetComponent<Camera>() != null || root.GetComponent<Light>() != null)
                    continue;

                foreach (var renderer in root.GetComponentsInChildren<MeshRenderer>(true))
                {
                    if (renderer.gameObject.GetComponent<MeshFilter>() != null)
                        objectsToCombine.Add(renderer.gameObject);
                }
            }

            if (objectsToCombine.Count == 0)
            {
                Log("WARNING: No renderers found in scene for MeshBaker.");
                return null;
            }

            Log($"Found {objectsToCombine.Count} mesh object(s) to combine.");

            // Classify all unique source materials as opaque or transparent
            var opaqueMaterials = new List<Material>();
            var transparentMaterials = new List<Material>();
            var seenMaterials = new HashSet<Material>();

            foreach (var go in objectsToCombine)
            {
                var r = go.GetComponent<Renderer>();
                if (r == null) continue;

                foreach (var mat in r.sharedMaterials)
                {
                    if (mat == null || seenMaterials.Contains(mat)) continue;
                    seenMaterials.Add(mat);

                    if (IsTransparentMaterial(mat))
                        transparentMaterials.Add(mat);
                    else
                        opaqueMaterials.Add(mat);
                }
            }

            Log($"Materials: {opaqueMaterials.Count} opaque, {transparentMaterials.Count} transparent.");

            bool useMultiMaterial = opaqueMaterials.Count > 0 && transparentMaterials.Count > 0;

            // Create a temporary host GameObject for MeshBaker components
            var bakerHost = new GameObject("_MeshBakerTemp");

            try
            {
                EnsureFolderExists(EXPORTED_FOLDER);

                string bakeResultsPath = Path.Combine(EXPORTED_FOLDER, $"{sceneId}_TextureBakeResult.asset");
                string prefabPath = Path.Combine(EXPORTED_FOLDER, $"{sceneId}_LOD.prefab");

                // =====================================================
                // Step A: Configure TextureBaker + "Create Empty Assets"
                // =====================================================
                var textureBaker = bakerHost.AddComponent<MB3_TextureBaker>();
                textureBaker.objsToMesh = objectsToCombine;
                textureBaker.atlasPadding = 2;
                textureBaker.maxAtlasSize = 4096;
                textureBaker.fixOutOfBoundsUVs = true;
                textureBaker.resizePowerOfTwoTextures = true;

                // glTFast uses "baseColorTexture" instead of "_BaseMap" — tell MeshBaker about it
                textureBaker.customShaderProperties = new List<ShaderTextureProperty>
                {
                    new ShaderTextureProperty("baseColorTexture", false, true, false),
                };

                // Only bake the base color texture, ignore everything else
                textureBaker.texturePropNamesToIgnore = new List<string>
                {
                    "_BumpMap",           // Normal map
                    "_MetallicGlossMap",  // Metallic
                    "_SpecGlossMap",      // Specular
                    "_OcclusionMap",      // Ambient Occlusion
                    "_EmissionMap",       // Emission
                    "_ParallaxMap",       // Height
                    "_DetailMask",        // Detail mask
                    "_DetailAlbedoMap",   // Detail albedo
                    "_DetailNormalMap",   // Detail normal
                    // glTFast property names
                    "metallicRoughnessTexture",
                    "normalTexture",
                    "occlusionTexture",
                    "emissiveTexture",
                    "transmissionTexture",
                };

                // Create assets in single-material mode — MeshBaker copies the shader from
                // the first source object.
                MB3_TextureBakerEditorInternal.CreateCombinedMaterialAssets(textureBaker, bakeResultsPath);
                AssetDatabase.Refresh();

                // Then: if both opaque and transparent materials exist, switch to multi-material mode
                if (useMultiMaterial)
                {
                    textureBaker.doMultiMaterial = true;

                    // Duplicate the material MeshBaker created for the transparent submesh
                    string opaquePath = AssetDatabase.GetAssetPath(textureBaker.resultMaterial);
                    string transparentPath = opaquePath.Replace(".mat", "-transparent.mat");
                    AssetDatabase.CopyAsset(opaquePath, transparentPath);
                    AssetDatabase.Refresh();

                    // Fix the opaque material — CreateCombinedMaterialAssets may have copied
                    // transparency properties if the first source object was transparent
                    var opaqueMat = textureBaker.resultMaterial;
                    SetMaterialOpaque(opaqueMat);
                    EditorUtility.SetDirty(opaqueMat);

                    // Configure the transparent material
                    var transparentMat = AssetDatabase.LoadAssetAtPath<Material>(transparentPath);
                    SetMaterialTransparent(transparentMat);
                    EditorUtility.SetDirty(transparentMat);

                    AssetDatabase.SaveAssets();

                    var opaqueEntry = new MB_MultiMaterial();
                    opaqueEntry.combinedMaterial = opaqueMat;
                    opaqueEntry.sourceMaterials = opaqueMaterials;
                    opaqueEntry.considerMeshUVs = true;

                    var transparentEntry = new MB_MultiMaterial();
                    transparentEntry.combinedMaterial = transparentMat;
                    transparentEntry.considerMeshUVs = true;
                    transparentEntry.sourceMaterials = transparentMaterials;

                    textureBaker.resultMaterials = new MB_MultiMaterial[] { opaqueEntry, transparentEntry };
                    Log("Using multi-material mode (opaque + transparent).");
                }

                Log($"TextureBakeResults={textureBaker.textureBakeResults != null}");

                Log("Baking textures into atlas...");
                textureBaker.CreateAtlases(null, true, new MB3_EditorMethods());

                if (textureBaker.textureBakeResults != null)
                    EditorUtility.SetDirty(textureBaker.textureBakeResults);

                AssetDatabase.SaveAssets();
                Log($"Texture atlas baked. TextureBakeResults materialsAndUVRects count: {textureBaker.textureBakeResults?.materialsAndUVRects?.Length ?? 0}");

                // Diagnostic: log what textures MeshBaker assigned to each combined material
                if (useMultiMaterial)
                {
                    for (int i = 0; i < textureBaker.resultMaterials.Length; i++)
                    {
                        var mat = textureBaker.resultMaterials[i].combinedMaterial;
                        if (mat == null) { Log($"  resultMaterials[{i}]: combinedMaterial is NULL"); continue; }
                        var texPropIds = mat.GetTexturePropertyNameIDs();
                        Log($"  resultMaterials[{i}] ({mat.name}, shader={mat.shader.name}):");
                        foreach (int id in texPropIds)
                        {
                            var tex = mat.GetTexture(id);
                            string propName = mat.GetTexturePropertyNames()[System.Array.IndexOf(mat.GetTexturePropertyNameIDs(), id)];
                            if (tex != null)
                                Log($"    {propName} = {tex.name} ({tex.width}x{tex.height})");
                            else
                                Log($"    {propName} = (none)");
                        }
                    }
                }
                else if (textureBaker.resultMaterial != null)
                {
                    var mat = textureBaker.resultMaterial;
                    var texPropIds = mat.GetTexturePropertyNameIDs();
                    Log($"  resultMaterial ({mat.name}, shader={mat.shader.name}):");
                    foreach (int id in texPropIds)
                    {
                        var tex = mat.GetTexture(id);
                        string propName = mat.GetTexturePropertyNames()[System.Array.IndexOf(mat.GetTexturePropertyNameIDs(), id)];
                        if (tex != null)
                            Log($"    {propName} = {tex.name} ({tex.width}x{tex.height})");
                        else
                            Log($"    {propName} = (none)");
                    }
                }

                // Switch all combined materials to DCL/Scene shader AFTER atlas is baked
                // (so MeshBaker writes textures with the original shader, then we swap —
                // _BaseMap is the same property name in both shaders, so the texture is preserved)
                var dclShader = Shader.Find("DCL/Scene");
                if (dclShader != null)
                {
                    void SwitchToDclScene(Material mat)
                    {
                        // MeshBaker wrote the atlas to "baseColorTexture" (glTFast's property name).
                        // DCL/Scene uses "_BaseMap". Grab the texture before swapping shader.
                        var atlas = mat.HasProperty("baseColorTexture") ? mat.GetTexture("baseColorTexture") : null;
                        // Also try _BaseMap in case MeshBaker wrote to that
                        if (atlas == null && mat.HasProperty("_BaseMap"))
                            atlas = mat.GetTexture("_BaseMap");

                        mat.shader = dclShader;

                        // Re-assign the atlas to _BaseMap on the DCL/Scene shader
                        if (atlas != null && mat.HasProperty("_BaseMap"))
                            mat.SetTexture("_BaseMap", atlas);

                        EditorUtility.SetDirty(mat);
                    }

                    if (useMultiMaterial)
                    {
                        foreach (var entry in textureBaker.resultMaterials)
                        {
                            if (entry.combinedMaterial != null)
                                SwitchToDclScene(entry.combinedMaterial);
                        }

                        // Re-apply opaque/transparent settings AFTER shader swap
                        // (shader swap resets render queue and other properties)
                        SetMaterialOpaque(textureBaker.resultMaterials[0].combinedMaterial);
                        if (textureBaker.resultMaterials.Length > 1)
                            SetMaterialTransparent(textureBaker.resultMaterials[1].combinedMaterial);
                    }
                    else if (textureBaker.resultMaterial != null)
                    {
                        SwitchToDclScene(textureBaker.resultMaterial);
                    }

                    AssetDatabase.SaveAssets();
                    Log("Switched combined material(s) to DCL/Scene shader.");
                }
                else
                {
                    Log("WARNING: DCL/Scene shader not found, using default.");
                }

                // =====================================================
                // Step C: Create empty result prefab
                // =====================================================
                var tempGo = new GameObject($"{sceneId}_LOD");
                PrefabUtility.SaveAsPrefabAsset(tempGo, prefabPath);
                UnityEngine.Object.DestroyImmediate(tempGo);
                AssetDatabase.Refresh();

                // =====================================================
                // Step D: "Bake" mesh into prefab
                //         (same as clicking "Bake" in the MeshBaker UI)
                // =====================================================
                var meshBakerGo = new GameObject("MeshBaker");
                meshBakerGo.transform.SetParent(bakerHost.transform);

                var meshBaker = meshBakerGo.AddComponent<MB3_MeshBaker>();
                meshBaker.textureBakeResults = textureBaker.textureBakeResults;
                meshBaker.meshCombiner.lightmapOption = MB2_LightmapOptions.copy_UV2_unchanged;
                meshBaker.meshCombiner.outputOption = MB2_OutputOptions.bakeIntoPrefab;
                meshBaker.resultPrefab = AssetDatabase.LoadAssetAtPath<GameObject>(prefabPath);
                meshBaker.resultPrefabLeaveInstanceInSceneAfterBake = false;

                Log($"MeshBaker setup: outputOption={meshBaker.meshCombiner.outputOption}, resultPrefab={meshBaker.resultPrefab != null}, textureBakeResults={meshBaker.textureBakeResults != null}");
                Log($"MeshBaker GetObjectsToCombine count: {meshBaker.GetObjectsToCombine()?.Count ?? 0}");

                Log("Combining meshes into prefab...");

                bool createdDummy;
                var so = new SerializedObject(meshBaker);
                bool success = MB3_MeshBakerEditorFunctions.BakeIntoCombined(meshBaker, out createdDummy, ref so);

                if (success)
                {
                    Log($"Prefab saved to: {prefabPath}");
                    AssetDatabase.SaveAssets();
                    AssetDatabase.Refresh();
                    return prefabPath;
                }
                else
                {
                    Log("WARNING: MeshBaker BakeIntoCombined failed. Check console for errors.");
                    return null;
                }
            }
            catch (Exception e)
            {
                Log($"ERROR: MeshBaker failed: {e.Message}\n{e.StackTrace}");
                Debug.LogError($"MeshBaker error: {e.Message}\n{e.StackTrace}");
                return null;
            }
            finally
            {
                UnityEngine.Object.DestroyImmediate(bakerHost);
            }
        }

        private static void SetMaterialOpaque(Material mat)
        {
            if (!mat.HasProperty("_Surface")) return;

            mat.SetFloat("_Surface", 0);
            mat.SetFloat("_SrcBlend", (float)UnityEngine.Rendering.BlendMode.One);
            mat.SetFloat("_DstBlend", (float)UnityEngine.Rendering.BlendMode.Zero);
            if (mat.HasProperty("_SrcBlendAlpha"))
                mat.SetFloat("_SrcBlendAlpha", (float)UnityEngine.Rendering.BlendMode.One);
            if (mat.HasProperty("_DstBlendAlpha"))
                mat.SetFloat("_DstBlendAlpha", (float)UnityEngine.Rendering.BlendMode.Zero);
            mat.SetFloat("_ZWrite", 1);
            mat.renderQueue = (int)UnityEngine.Rendering.RenderQueue.Geometry;
            mat.SetOverrideTag("RenderType", "Opaque");
            mat.DisableKeyword("_SURFACE_TYPE_TRANSPARENT");
            mat.DisableKeyword("_ALPHAPREMULTIPLY_ON");
            mat.DisableKeyword("_ALPHABLEND_ON");
        }

        private static void SetMaterialTransparent(Material mat)
        {
            if (!mat.HasProperty("_Surface")) return;

            mat.SetFloat("_Surface", 1);
            mat.SetFloat("_Blend", 0); // Alpha
            mat.SetFloat("_SrcBlend", (float)UnityEngine.Rendering.BlendMode.SrcAlpha);
            mat.SetFloat("_DstBlend", (float)UnityEngine.Rendering.BlendMode.OneMinusSrcAlpha);
            if (mat.HasProperty("_SrcBlendAlpha"))
                mat.SetFloat("_SrcBlendAlpha", (float)UnityEngine.Rendering.BlendMode.One);
            if (mat.HasProperty("_DstBlendAlpha"))
                mat.SetFloat("_DstBlendAlpha", (float)UnityEngine.Rendering.BlendMode.OneMinusSrcAlpha);
            mat.SetFloat("_ZWrite", 0);
            mat.SetFloat("_AlphaClip", 0);
            mat.renderQueue = (int)UnityEngine.Rendering.RenderQueue.Transparent;
            mat.SetOverrideTag("RenderType", "Transparent");
            mat.EnableKeyword("_SURFACE_TYPE_TRANSPARENT");
            mat.DisableKeyword("_ALPHATEST_ON");
            mat.DisableKeyword("_ALPHAPREMULTIPLY_ON");

            // Re-enable DepthOnly pass (disabled by the glTFast shader copy)
            mat.SetShaderPassEnabled("DepthOnly", true);
            mat.SetShaderPassEnabled("TransparentDepthPrepass", true);
            mat.SetShaderPassEnabled("TransparentDepthPostpass", true);
            mat.SetShaderPassEnabled("TransparentBackface", true);
        }

        private static bool IsTransparentMaterial(Material mat)
        {
            if (mat == null) return false;

            // URP _Surface property: 0 = Opaque, 1 = Transparent
            if (mat.HasProperty("_Surface") && mat.GetFloat("_Surface") >= 1f)
                return true;

            // Common transparency keywords
            if (mat.IsKeywordEnabled("_ALPHABLEND_ON") ||
                mat.IsKeywordEnabled("_ALPHATEST_ON") ||
                mat.IsKeywordEnabled("_SURFACE_TYPE_TRANSPARENT"))
                return true;

            // Render queue >= AlphaTest (2450+)
            if (mat.renderQueue >= (int)UnityEngine.Rendering.RenderQueue.AlphaTest)
                return true;

            return false;
        }

        #endregion

        #region Step 3: Export GLB

        /// <summary>
        /// Collects all root GameObjects in the scene (excluding cameras and lights),
        /// disables SkinnedMeshRenderers to avoid bone/joint export issues,
        /// and exports as a single GLB file using glTFast's GameObjectExport.
        /// </summary>
        private async UniTask<string> ExportSceneToGlb(string sceneId, string overrideFileName = null)
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

            string exportFileName = overrideFileName ?? $"{sceneId}_scene.glb";
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

        #region Step 4: gltfpack decimation

        private string RunGltfpack(string inputGlbPath, string sceneId)
        {
            string gltfpackPath = Path.GetFullPath(Path.Combine(Application.dataPath, "gltfpack"));

            if (!File.Exists(gltfpackPath))
            {
                Log($"ERROR: gltfpack not found at: {gltfpackPath}");
                return null;
            }

            string outputFileName = $"{sceneId}_scene_lod.glb";
            string outputPath = Path.Combine(EXPORTED_FOLDER, outputFileName);
            string fullInputPath = Path.GetFullPath(inputGlbPath);
            string fullOutputPath = Path.GetFullPath(outputPath);

            // -si 0.1 = simplify to 10% of original triangles
            string arguments = $"-i \"{fullInputPath}\" -o \"{fullOutputPath}\" -si 0.1";
            Log($"Running: gltfpack {arguments}");

            try
            {
                var startInfo = new ProcessStartInfo
                {
                    FileName = gltfpackPath,
                    Arguments = arguments,
                    RedirectStandardOutput = true,
                    RedirectStandardError = true,
                    UseShellExecute = false,
                    CreateNoWindow = true
                };

                using (var process = new Process { StartInfo = startInfo })
                {
                    var output = new System.Text.StringBuilder();

                    process.OutputDataReceived += (sender, e) =>
                    {
                        if (!string.IsNullOrEmpty(e.Data))
                            output.AppendLine(e.Data);
                    };

                    process.ErrorDataReceived += (sender, e) =>
                    {
                        if (!string.IsNullOrEmpty(e.Data))
                            output.AppendLine(e.Data);
                    };

                    process.Start();
                    process.BeginOutputReadLine();
                    process.BeginErrorReadLine();

                    bool completed = process.WaitForExit(120000);

                    if (!completed)
                    {
                        process.Kill();
                        Log("ERROR: gltfpack timed out after 2 minutes.");
                        return null;
                    }

                    string processOutput = output.ToString();
                    if (!string.IsNullOrEmpty(processOutput))
                        Log(processOutput);

                    if (process.ExitCode != 0)
                    {
                        Log($"ERROR: gltfpack failed with exit code {process.ExitCode}");
                        return null;
                    }
                }

                Log($"Decimated LOD exported to: {outputPath}");
                AssetDatabase.Refresh();
                return outputPath;
            }
            catch (Exception e)
            {
                Log($"ERROR: Failed to run gltfpack: {e.Message}");
                Debug.LogError($"gltfpack error: {e.Message}");
                return null;
            }
        }

        #endregion

        #region Import & Scene helpers

        /// <summary>
        /// Destroys all non-camera/non-light root GameObjects in the active scene.
        /// </summary>
        private void ClearSceneObjects()
        {
            var allRootObjects = UnityEngine.SceneManagement.SceneManager.GetActiveScene().GetRootGameObjects();
            int count = 0;

            foreach (var go in allRootObjects)
            {
                if (go.GetComponent<Camera>() != null || go.GetComponent<Light>() != null)
                    continue;

                UnityEngine.Object.DestroyImmediate(go);
                count++;
            }

            Log($"Cleared {count} object(s) from scene.");
        }

        /// <summary>
        /// Imports a GLB file into the active scene using glTFast.
        /// </summary>
        private async UniTask ImportGlbIntoScene(string glbPath)
        {
            string fullPath = Path.GetFullPath(glbPath);

            Log($"Importing GLB: {fullPath}");

            var gltfImport = new GltfImport(deferAgent: new UninterruptedDeferAgent(), logger: new ConsoleLogger());
            bool loaded = await gltfImport.LoadFile(fullPath);

            if (!loaded)
            {
                Log("ERROR: Failed to load decimated GLB.");
                return;
            }

            var parent = new GameObject("_ImportedDecimated");
            bool instantiated = await gltfImport.InstantiateMainSceneAsync(parent.transform);

            if (!instantiated)
            {
                Log("ERROR: Failed to instantiate decimated GLB scene.");
                UnityEngine.Object.DestroyImmediate(parent);
                return;
            }

            Log($"Decimated GLB imported with {parent.GetComponentsInChildren<MeshRenderer>().Length} renderer(s).");

            // Make all textures readable so MeshBaker can build atlases
            MakeAllTexturesReadable(parent);
        }

        /// <summary>
        /// glTFast imports textures as non-readable. MeshBaker needs readable textures
        /// to build atlases. This copies each texture via RenderTexture to make it readable.
        /// </summary>
        private void MakeAllTexturesReadable(GameObject root)
        {
            int count = 0;
            var renderers = root.GetComponentsInChildren<Renderer>(true);

            foreach (var renderer in renderers)
            {
                foreach (var mat in renderer.sharedMaterials)
                {
                    if (mat == null) continue;

                    var texProps = mat.GetTexturePropertyNameIDs();
                    foreach (int propId in texProps)
                    {
                        var tex = mat.GetTexture(propId) as Texture2D;
                        if (tex == null || tex.isReadable) continue;

                        var readable = CopyTextureToReadable(tex);
                        if (readable != null)
                        {
                            mat.SetTexture(propId, readable);
                            count++;
                        }
                    }
                }
            }

            if (count > 0)
                Log($"Made {count} texture(s) readable for MeshBaker.");
        }

        private Texture2D CopyTextureToReadable(Texture2D source)
        {
            var rt = RenderTexture.GetTemporary(source.width, source.height, 0, RenderTextureFormat.ARGB32);
            Graphics.Blit(source, rt);

            var previous = RenderTexture.active;
            RenderTexture.active = rt;

            var readable = new Texture2D(source.width, source.height, TextureFormat.RGBA32, false);
            readable.ReadPixels(new Rect(0, 0, source.width, source.height), 0, 0);
            readable.Apply();
            readable.name = source.name;

            RenderTexture.active = previous;
            RenderTexture.ReleaseTemporary(rt);

            return readable;
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
