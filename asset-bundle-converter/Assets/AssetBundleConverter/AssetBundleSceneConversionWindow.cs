using AssetBundleConverter.Wearables;
using System.Threading.Tasks;
using DCL;
using DCL.ABConverter;
using System;
using UnityEditor;
using UnityEngine;
using Random = System.Random;

namespace AssetBundleConverter
{
    public class AssetBundleSceneConversionWindow : EditorWindow
    {
        private static AssetBundleSceneConversionWindow thisWindow;

        private const string TAB_SCENE = "Entity by ID";
        private const string TAB_PARCELS = "Entity by Pointer";
        private const string TAB_RANDOM = "Random Pointer";
        private const string TAB_WEARABLES_COLLECTION = "Wearables Collection";
        private const string TEST_BATCHMODE = "Test Batchmode";

        private readonly string[] tabs = { TAB_SCENE, TAB_PARCELS, TAB_RANDOM, TAB_WEARABLES_COLLECTION, TEST_BATCHMODE };

        private string entityId = "QmYy2TMDEfag99yZV4ZdpjievYUfdQgBVfFHKCDAge3zQi";
        private string wearablesCollectionId = "urn:decentraland:off-chain:base-avatars";
        private string debugEntity = "bafkreib66ufmbowp4ee2u3kdu6t52kouie7kd7tfrlv3l5kejz6yjcaq5i";
        private string batchModeParams = "";
        private string endPoint = "/content/contents/";
        private bool placeOnScene = true;
        private bool visualTest = false;
        private bool clearDownloads = true;
        private bool createAssetBundle = true;
        private bool verbose = true;
        private int currentTab = 0;
        private int xCoord = -110;
        private int yCoord = -110;
        private ContentServerUtils.ApiTLD tld = ContentServerUtils.ApiTLD.ORG;
        private ShaderType shader = ShaderType.Dcl;

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

        private void OnGUI()
        {
            GUILayout.Space(5);
            visualTest = EditorGUILayout.Toggle("Visual Test", visualTest);
            placeOnScene = EditorGUILayout.Toggle("Place on Scene", placeOnScene);
            createAssetBundle = EditorGUILayout.Toggle("Create Asset Bundle", createAssetBundle);
            clearDownloads = EditorGUILayout.Toggle("Clear Downloads", clearDownloads);
            showDebugOptions = EditorGUILayout.Toggle("Show debug options", showDebugOptions);
            endPoint = EditorGUILayout.TextField("Content endpoint", endPoint);
            tld = (ContentServerUtils.ApiTLD)EditorGUILayout.EnumPopup("Top level domain", tld);
            shader = (ShaderType)EditorGUILayout.EnumPopup("Shader Type", shader);
            verbose = EditorGUILayout.Toggle("Verbose", verbose);
            GUILayout.Space(5);

            currentTab = GUILayout.Toolbar(currentTab, tabs);

            RenderDebugOptions();

            GUILayout.Space(5);

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
                }
            }
            catch (Exception e) { Debug.LogException(e); }
        }

        private void RenderTestBatchmode()
        {
            batchModeParams = EditorGUILayout.TextField("Params", batchModeParams);

            GUILayout.FlexibleSpace();

            if (GUILayout.Button("Start"))
            {
                try
                {
                    SceneClient.ExportSceneToAssetBundles(batchModeParams.Split(","));
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
                    var state = await SceneClient.ConvertEntityById(entityId, clientSettings);
                    OnConversionEnd(state);
                }
                catch (Exception e) { Debug.LogException(e); }
            }
        }

        private async Task RenderEntityByPointerAsync()
        {
            xCoord = EditorGUILayout.IntField("X", xCoord);
            yCoord = EditorGUILayout.IntField("Y", yCoord);

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

                try
                {
                    var state = await SceneClient.ConvertWearablesCollection(wearablesCollectionId, clientSettings);
                    OnConversionEnd(state);
                }
                catch (Exception e) { Debug.LogException(e); }
            }
        }

        private void SetupSettings()
        {
            clientSettings = new ClientSettings
            {
                endPoint = endPoint,
                visualTest = visualTest,
                cleanAndExitOnFinish = false,
                tld = tld,
                createAssetBundle = createAssetBundle,
                clearDirectoriesOnStart = clearDownloads,
                importOnlyEntity = showDebugOptions ? debugEntity : "",
                shaderType = shader,
                stripShaders = stripShaders,
                importGltf = importGltf,
                placeOnScene = placeOnScene
            };

            Debug.ClearDeveloperConsole();
        }

        private void OnConversionEnd(DCL.ABConverter.AssetBundleConverter.State state)
        {
            if (createAssetBundle && state.lastErrorCode == DCL.ABConverter.AssetBundleConverter.ErrorCodes.SUCCESS)
                EditorUtility.RevealInFinder(Config.ASSET_BUNDLES_PATH_ROOT);
        }
    }
}
