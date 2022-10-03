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

        private const string TAB_SCENE = "Single Scene";
        private const string TAB_PARCELS = "Parcels";
        private const string TAB_ASSET = "Asset";
        private const string TAB_WEARABLE = "Wearable";
        private const string TAB_COLLECTION = "Collection";
        
        private readonly string[] tabs = { TAB_SCENE, TAB_PARCELS, TAB_ASSET, TAB_WEARABLE, TAB_COLLECTION };

        private string sceneHash = "QmXMzPLZNx5EHiYi3tK9MT5g9HqjAqgyAoZUu2LfAXJcSM";
        private string assetHash = "QmS9eDwvcEpyYXChz6pFpyWyfyajiXbt6KA4CxQa3JKPGC";
        private bool runVisualTests = false;
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
            tld = (ContentServerUtils.ApiTLD)EditorGUILayout.EnumPopup("Top level domain", tld);

            GUILayout.Space(5);

            currentTab = GUILayout.Toolbar(currentTab, tabs);
            
            GUILayout.Space(5);
            
            clientSettings = new ClientSettings
            {
                runVisualTests = runVisualTests,
                cleanAndExitOnFinish = false,
                tld = tld,
            };

            switch (currentTab)
            {
                case 0:
                    await RenderScene();
                    break;
                case 1:
                    await RenderParcel();
                    break;
                case 2:
                    await RenderAsset();
                    break;
            }
        }

        private async Task RenderScene()
        {
            sceneHash = EditorGUILayout.TextField("Scene Hash", sceneHash);

            GUILayout.FlexibleSpace();

            if (GUILayout.Button("Start"))
            {
                await SceneClient.DumpScene(sceneHash, clientSettings);
                EditorUtility.RevealInFinder(Config.ASSET_BUNDLES_PATH_ROOT);
            }
        }

        private async Task RenderParcel()
        {
            xCoord = EditorGUILayout.IntField("X", xCoord);
            yCoord = EditorGUILayout.IntField("Y", yCoord);
            radius = EditorGUILayout.IntField("Radius", radius);

            GUILayout.FlexibleSpace();

            if (GUILayout.Button("Start"))
            {
                var targetPosition = new Vector2Int(xCoord, yCoord);
                var targetRadius = new Vector2Int(radius, radius);
                await SceneClient.DumpArea(targetPosition, targetRadius, clientSettings);
                EditorUtility.RevealInFinder(Config.ASSET_BUNDLES_PATH_ROOT);
            }
        }

        private async Task RenderAsset()
        {
            assetHash = EditorGUILayout.TextField("Asset Hash", assetHash);
            sceneHash = EditorGUILayout.TextField("Scene Hash", sceneHash);

            GUILayout.FlexibleSpace();
            
            if (GUILayout.Button("Start"))
            {
                await SceneClient.DumpAsset(assetHash, sceneHash, clientSettings);

                EditorUtility.RevealInFinder(Config.ASSET_BUNDLES_PATH_ROOT);
            }
            
        }
    }
}