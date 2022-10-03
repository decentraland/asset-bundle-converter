using System.Threading.Tasks;
using DCL;
using DCL.ABConverter;
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
        private string endPoint = "/content/contents/";
        private bool runVisualTests = true;
        private int currentTab = 0;
        private int xCoord = -110;
        private int yCoord = -110;
        private int radius = 1;
        private ContentServerUtils.ApiTLD tld = ContentServerUtils.ApiTLD.ORG;
        
        private ClientSettings clientSettings;

        [MenuItem("Decentraland/Asset Bundle Converter")]
        static void Init()
        {
            AssetBundleSceneConversionWindow window =
                (AssetBundleSceneConversionWindow)GetWindow(typeof(AssetBundleSceneConversionWindow));

            thisWindow = window;
            thisWindow.minSize = new Vector2(550, 160);
            thisWindow.Show();
        }

        async void OnGUI()
        {
            GUILayout.Space(5);
            runVisualTests = EditorGUILayout.Toggle("Run visual tests", runVisualTests);
            endPoint = EditorGUILayout.TextField("Content endpoint", endPoint);
            tld = (ContentServerUtils.ApiTLD)EditorGUILayout.EnumPopup("Top level domain", tld);
            GUILayout.Space(5);

            currentTab = GUILayout.Toolbar(currentTab, tabs);
            
            GUILayout.Space(5);

            // todo: de-static-ize this
            ContentServerUtils.customEndpoint = endPoint;
            
            clientSettings = new ClientSettings
            {
                runVisualTests = runVisualTests,
                cleanAndExitOnFinish = false,
                tld = tld,
            };

            switch (currentTab)
            {
                case 0:
                    await RenderEntityById();
                    break;
                case 1:
                    await RenderEntityByPointer();
                    break;
            }
        }

        private async Task RenderEntityById()
        {
            entityId = EditorGUILayout.TextField("ID", entityId);

            GUILayout.FlexibleSpace();

            if (GUILayout.Button("Start"))
            {
                await SceneClient.ConvertEntityById(entityId, clientSettings);
                EditorUtility.RevealInFinder(Config.ASSET_BUNDLES_PATH_ROOT);
            }
        }

        private async Task RenderEntityByPointer()
        {
            xCoord = EditorGUILayout.IntField("X", xCoord);
            yCoord = EditorGUILayout.IntField("Y", yCoord);

            GUILayout.FlexibleSpace();

            if (GUILayout.Button("Start"))
            {
                var targetPosition = new Vector2Int(xCoord, yCoord);
                await SceneClient.ConvertEntityByPointer(targetPosition, clientSettings);
                EditorUtility.RevealInFinder(Config.ASSET_BUNDLES_PATH_ROOT);
            }
        }
    }
}