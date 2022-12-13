using System.Threading.Tasks;
using DCL;
using DCL.ABConverter;
using System;
using UnityEditor;
using UnityEngine;

namespace AssetBundleConverter
{
    public class AssetBundleSceneConversionWindow : EditorWindow
    {
        private static AssetBundleSceneConversionWindow thisWindow;

        private const string TAB_SCENE = "Entity by ID";
        private const string TAB_PARCELS = "Entity by Pointer";

        private readonly string[] tabs = { TAB_SCENE, TAB_PARCELS };

        private string entityId = "QmYy2TMDEfag99yZV4ZdpjievYUfdQgBVfFHKCDAge3zQi";
        private string debugEntity = "bafkreib66ufmbowp4ee2u3kdu6t52kouie7kd7tfrlv3l5kejz6yjcaq5i";
        private string endPoint = "/content/contents/";
        private bool visualTest = false;
        private bool clearDownloads = true;
        private bool createAssetBundle = true;
        private int currentTab = 0;
        private int xCoord = -110;
        private int yCoord = -110;
        private int radius = 1;
        private ContentServerUtils.ApiTLD tld = ContentServerUtils.ApiTLD.ORG;
        private ShaderType shader = ShaderType.Dcl;

        private ClientSettings clientSettings;
        private bool showDebugOptions;

        [MenuItem("Decentraland/Asset Bundle Converter")]
        private static void Init()
        {
            AssetBundleSceneConversionWindow window =
                (AssetBundleSceneConversionWindow)GetWindow(typeof(AssetBundleSceneConversionWindow));

            thisWindow = window;
            thisWindow.minSize = new Vector2(550, 160);
            thisWindow.Show();
        }

        private async void OnGUI()
        {
            GUILayout.Space(5);
            visualTest = EditorGUILayout.Toggle("Visual Test", visualTest);
            createAssetBundle = EditorGUILayout.Toggle("Create Asset Bundle", createAssetBundle);
            clearDownloads = EditorGUILayout.Toggle("Clear Downloads", clearDownloads);
            showDebugOptions = EditorGUILayout.Toggle("Show debug options", showDebugOptions);
            endPoint = EditorGUILayout.TextField("Content endpoint", endPoint);
            tld = (ContentServerUtils.ApiTLD)EditorGUILayout.EnumPopup("Top level domain", tld);
            shader = (ShaderType)EditorGUILayout.EnumPopup("Shader Type", shader);
            GUILayout.Space(5);

            currentTab = GUILayout.Toolbar(currentTab, tabs);

            RenderDebugOptions();

            GUILayout.Space(5);

            switch (currentTab)
            {
                case 0:
                    await RenderEntityByIdAsync();
                    break;
                case 1:
                    await RenderEntityByPointerAsync();
                    break;
            }
        }

        private void RenderDebugOptions()
        {
            if (!showDebugOptions) return;
            GUILayout.Space(5);
            Color defaultColor = GUI.color;
            GUI.color = Color.green;
            debugEntity = EditorGUILayout.TextField("Import only hash", debugEntity);
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
                var state = await SceneClient.ConvertEntityById(entityId, clientSettings);
                OnConversionEnd(state);
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
                shaderType = shader
            };
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
                var state = await SceneClient.ConvertEntityByPointer(targetPosition, clientSettings);
                OnConversionEnd(state);
            }
        }

        private void OnConversionEnd(DCL.ABConverter.AssetBundleConverter.State state)
        {
            if (createAssetBundle && state.lastErrorCode == DCL.ABConverter.AssetBundleConverter.ErrorCodes.SUCCESS)
                EditorUtility.RevealInFinder(Config.ASSET_BUNDLES_PATH_ROOT);
        }
    }
}
