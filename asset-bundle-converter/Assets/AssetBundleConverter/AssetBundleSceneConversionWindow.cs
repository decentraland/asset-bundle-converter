using AssetBundleConverter.Persistence;
using System.Threading.Tasks;
using DCL.ABConverter;
using System;
using System.Linq;
using UnityEditor;
using UnityEngine;

namespace AssetBundleConverter
{
    public enum SupportedBuildTarget
    {
        WebGL,
        Windows,
        Mac,
    }

    public class AssetBundleSceneConversionWindow : EditorWindow
    {
        private static AssetBundleSceneConversionWindow thisWindow;

        private const string TAB_SCENE = "Entity by ID";
        private const string TAB_PARCELS = "Entity by Pointer";
        private const string TAB_RANDOM = "Random Pointer";
        private const string TAB_WEARABLES_COLLECTION = "Wearables Collection";
        private const string TEST_BATCHMODE = "Test Batchmode";
        private const string EMPTY_SCENES = "Empty Scenes";
        private const string URL_PEERS = "Peers";
        private const string URL_WORLDS = "Worlds";
        private const string CUSTOM = "Custom";

        private const string PEERS_URL = "https://peer.decentraland.org/content/contents/";
        private const string WORLDS_URL = "https://worlds-content-server.decentraland.org/contents/";

        private readonly string[] tabs = { TAB_SCENE, TAB_PARCELS, TAB_RANDOM, TAB_WEARABLES_COLLECTION, TEST_BATCHMODE, EMPTY_SCENES };
        private readonly string[] urlOptions = { URL_PEERS, URL_WORLDS, CUSTOM };

        private string entityId = "QmYy2TMDEfag99yZV4ZdpjievYUfdQgBVfFHKCDAge3zQi";
        private string wearablesCollectionId = "urn:decentraland:off-chain:base-avatars";
        private string debugEntity = "bafkreib66ufmbowp4ee2u3kdu6t52kouie7kd7tfrlv3l5kejz6yjcaq5i";

        // The empty scenes url should be like "https://cdn.decentraland.org/@dcl/explorer/1.0.152291-20231017100112.commit-07d38e3/loader/empty-scenes/contents/"
        private string mappingName = "../mappings.json";
        private string batchBaseUrl = "";
        private string batchSceneId = "";
        private string batchModeParams = "";
        private string baseUrl;
        private bool placeOnScene = true;
        private bool visualTest = false;
        private bool clearDownloads = true;
        private PersistentSetting<float> failingConversionTolerance;
        private PersistentSetting<bool> createAssetBundle;
        private PersistentSetting<bool> verbose;
        private int currentTab = 0;
        private int currentUrlOption = 0;

        private PersistentSetting<int> xCoord;
        private PersistentSetting<int> yCoord;

        private PersistentSetting<BuildPipelineType> buildPipelineType;
        private ShaderType shader = ShaderType.Dcl;
        private bool includeShaderVariants;
        private PersistentSetting<SupportedBuildTarget> buildTarget;

        private ClientSettings clientSettings;
        private bool showDebugOptions;
        private bool stripShaders = true;
        private bool importGltf = true;

        [MenuItem("Decentraland/Asset Bundle Converter")]
        private static void Init()
        {
            AssetBundleSceneConversionWindow window =
                (AssetBundleSceneConversionWindow)GetWindow(typeof(AssetBundleSceneConversionWindow));

            thisWindow = window;
            thisWindow.minSize = new Vector2(550, 160);
            thisWindow.Show();
        }

        private void OnEnable()
        {
            createAssetBundle = PersistentSetting.CreateBool(nameof(createAssetBundle), true);
            verbose = PersistentSetting.CreateBool(nameof(verbose), false);
            xCoord = PersistentSetting.CreateInt(nameof(xCoord), -110);
            yCoord = PersistentSetting.CreateInt(nameof(yCoord), -110);
            buildPipelineType = PersistentSetting.CreateEnum(nameof(buildPipelineType), BuildPipelineType.Scriptable);
            buildTarget = PersistentSetting.CreateEnum(nameof(buildTarget), SupportedBuildTarget.WebGL);
            failingConversionTolerance = PersistentSetting.CreateFloat(nameof(failingConversionTolerance), 0.05f); // 5%
        }

        private void OnGUI()
        {
            GUILayout.Space(5);
            buildPipelineType.Value = (BuildPipelineType)EditorGUILayout.EnumPopup("Build Pipeline", buildPipelineType);
            buildTarget.Value = (SupportedBuildTarget)EditorGUILayout.EnumPopup("Build Target", buildTarget);

            visualTest = EditorGUILayout.Toggle("Visual Test", visualTest);
            placeOnScene = EditorGUILayout.Toggle("Place on Scene", placeOnScene);
            createAssetBundle.Value = EditorGUILayout.Toggle("Create Asset Bundle", createAssetBundle);
            failingConversionTolerance.Value = ClampConversionTolerance(EditorGUILayout.FloatField("Failed Conversion Tolerance", failingConversionTolerance));
            clearDownloads = EditorGUILayout.Toggle("Clear Downloads", clearDownloads);
            includeShaderVariants = EditorGUILayout.Toggle("Include Shader Variants", includeShaderVariants);
            showDebugOptions = EditorGUILayout.Toggle("Show debug options", showDebugOptions);

            RenderUrlEditor();

            GUILayout.Space(5);

            currentTab = GUILayout.Toolbar(currentTab, tabs);

            RenderDebugOptions();

            GUILayout.Space(5);
#pragma warning disable CS4014
            try
            {
                switch (currentTab)
                {
                    case 0:
                        RenderEntityByIdAsync();
                        break;
                    case 1:
                        RenderEntityByPointerAsync();
                        break;
                    case 2:
                        RenderRandomPointerAsync();
                        break;
                    case 3:
                        RenderWearablesCollectionAsync();
                        break;
                    case 4:
                        RenderTestBatchmode();
                        break;
                    case 5:
                        RenderEmptyScenesAsync();
                        break;
                }
            }
            catch (Exception e) { Debug.LogException(e); }
        }
#pragma warning restore CS4014

        private void RenderUrlEditor()
        {
            GUILayout.Space(5);
            GUILayout.Label("BaseUrl");
            currentUrlOption = GUILayout.Toolbar(currentUrlOption, urlOptions);

            switch (currentUrlOption)
            {
                case 0:
                    baseUrl = PEERS_URL;
                    GUILayout.Label(baseUrl);

                    break;
                case 1:
                    baseUrl = WORLDS_URL;
                    GUILayout.Label(baseUrl);

                    break;
                case 2:
                    baseUrl = EditorGUILayout.TextField("", baseUrl);

                    break;
            }
        }

        private void RenderTestBatchmode()
        {
            batchSceneId = EditorGUILayout.TextField("sceneId", batchSceneId);
            batchBaseUrl = EditorGUILayout.TextField("baseUrl", batchBaseUrl);
            batchModeParams = EditorGUILayout.TextField("additionalParams", batchModeParams);

            GUILayout.FlexibleSpace();

            if (GUILayout.Button("Start"))
            {
                try
                {
                    string[] additionalArgs = batchModeParams.Split(",");

                    string[] baseArgs = new[]
                    {
                        "-sceneCid", batchSceneId,
                        "-baseUrl", batchBaseUrl
                    };
                    SceneClient.ExportSceneToAssetBundles(baseArgs.Concat(additionalArgs).ToArray(), new ClientSettings(){ verbose = verbose });
                }
                catch (Exception e) { Debug.LogException(e); }
            }
        }

        private void RenderDebugOptions()
        {
            if (!showDebugOptions) return;
            GUILayout.Space(5);
            Color defaultColor = GUI.color;
            GUI.color = Color.green;
            debugEntity = EditorGUILayout.TextField("Import only hash", debugEntity);
            stripShaders = EditorGUILayout.Toggle("Strip Shaders", stripShaders);
            importGltf = EditorGUILayout.Toggle("Import GLTFs", importGltf);
            shader = (ShaderType)EditorGUILayout.EnumPopup("Shader Type", shader);
            verbose.Value = EditorGUILayout.Toggle("Verbose", verbose);
            GUI.color = defaultColor;
            GUILayout.Space(5);
        }

        private async Task RenderEntityByIdAsync()
        {
            entityId = EditorGUILayout.TextField("ID", entityId);

            GUILayout.FlexibleSpace();

            if (GUILayout.Button("Start"))
            {
                SetupSettings();
                clientSettings.targetHash = entityId;

                try
                {
                    var state = await SceneClient.ConvertEntityById(clientSettings);
                    OnConversionEnd(state);
                }
                catch (Exception e) { Debug.LogException(e); }
            }
        }

        private async Task RenderEmptyScenesAsync()
        {
            mappingName = EditorGUILayout.TextField("Mapping Name", mappingName);

            GUILayout.FlexibleSpace();

            if (GUILayout.Button("Start"))
            {
                SetupSettings();
                clientSettings.targetHash = mappingName;

                try
                {
                    var state = await SceneClient.ConvertEmptyScenesByMapping(clientSettings);
                    OnConversionEnd(state);
                }
                catch (Exception e) { Debug.LogException(e); }
            }
        }

        private async Task RenderEntityByPointerAsync()
        {
            xCoord.Value = EditorGUILayout.IntField("X", xCoord);
            yCoord.Value = EditorGUILayout.IntField("Y", yCoord);

            GUILayout.FlexibleSpace();

            if (GUILayout.Button("Start"))
            {
                SetupSettings();
                var targetPosition = new Vector2Int(xCoord, yCoord);
                clientSettings.targetPointer = targetPosition;

                try
                {
                    var state = await SceneClient.ConvertEntityByPointer(clientSettings);
                    OnConversionEnd(state);
                    Debug.Log($"Finished! with state {state.step} {state.lastErrorCode}");
                }
                catch (Exception e) { Debug.LogException(e); }
            }
        }

        private async Task RenderRandomPointerAsync()
        {
            GUILayout.FlexibleSpace();

            if (GUILayout.Button("Start"))
            {
                SetupSettings();

                try
                {
                    int x = UnityEngine.Random.Range(-150, 151);
                    int y = UnityEngine.Random.Range(-150, 151);

                    Debug.Log($"Converting {x},{y}");
                    var targetPosition = new Vector2Int(x, y);
                    clientSettings.targetPointer = targetPosition;

                    var state = await SceneClient.ConvertEntityByPointer(clientSettings);
                    OnConversionEnd(state);
                }
                catch (Exception e) { Debug.LogException(e); }
            }
        }

        private async Task RenderWearablesCollectionAsync()
        {
            wearablesCollectionId = EditorGUILayout.TextField("Collection ID", wearablesCollectionId);

            GUILayout.FlexibleSpace();

            if (GUILayout.Button("Start"))
            {
                SetupSettings();
                clientSettings.targetHash = wearablesCollectionId;
                try
                {
                    var state = await SceneClient.ConvertWearablesCollection(clientSettings);
                    OnConversionEnd(state);
                }
                catch (Exception e) { Debug.LogException(e); }
            }
        }

        private float ClampConversionTolerance(float value) =>
            Mathf.Clamp(value, 0f, 0.5f);

        private void SetupSettings()
        {
            clientSettings = new ClientSettings
            {
                visualTest = visualTest,
                baseUrl = baseUrl,
                cleanAndExitOnFinish = false,
                createAssetBundle = createAssetBundle,
                failingConversionTolerance = ClampConversionTolerance(failingConversionTolerance),
                clearDirectoriesOnStart = clearDownloads,
                importOnlyEntity = showDebugOptions ? debugEntity : "",
                shaderType = shader,
                stripShaders = stripShaders,
                includeShaderVariants = includeShaderVariants,
                importGltf = importGltf,
                placeOnScene = placeOnScene,
                verbose = verbose,
                buildTarget = GetBuildTarget(),
                BuildPipelineType = buildPipelineType
            };
        }

        private void OnConversionEnd(ConversionState state)
        {
            if (createAssetBundle && state.lastErrorCode == ErrorCodes.SUCCESS)
                EditorUtility.RevealInFinder(Config.ASSET_BUNDLES_PATH_ROOT);
        }

        private BuildTarget GetBuildTarget()
        {
            return buildTarget.Value switch
                   {
                       SupportedBuildTarget.WebGL => BuildTarget.WebGL,
                       SupportedBuildTarget.Windows => BuildTarget.StandaloneWindows64,
                       SupportedBuildTarget.Mac => BuildTarget.StandaloneOSX,
                       _ => BuildTarget.WebGL
                   };
        }
    }
}
