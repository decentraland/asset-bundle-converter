using DCL.ABConverter;
using UnityEditor;
using UnityEngine;

namespace AssetBundleConverter
{
    public class AssetBundleSceneConversionWindow : EditorWindow
    {
        private int xCoord = -110;
        private int yCoord = -110;
        private int radius = 1;

        private bool useUid = false;
        private string uid = "QmXMzPLZNx5EHiYi3tK9MT5g9HqjAqgyAoZUu2LfAXJcSM";
        private static AssetBundleSceneConversionWindow thisWindow;

        [MenuItem("Decentraland/Convert Scene")]
        static void Init()
        {
            AssetBundleSceneConversionWindow window = (AssetBundleSceneConversionWindow)GetWindow(typeof(AssetBundleSceneConversionWindow));
            thisWindow = window;
            thisWindow.minSize = new Vector2(550, 160);
            thisWindow.Show();
        }

        async void OnGUI()
        {
            GUILayout.Space(5);

            useUid = EditorGUILayout.Toggle("Use Scene UID", useUid);

            if (useUid)
            {
                GUILayout.Label("Select Scene UID to convert", EditorStyles.boldLabel);
                GUILayout.Space(10);

                uid = EditorGUILayout.TextField("UID", uid);
                
                GUILayout.FlexibleSpace();
                if (GUILayout.Button("Start"))
                {
                    await SceneClient.DumpScene(uid);
                    EditorUtility.RevealInFinder(Config.ASSET_BUNDLES_PATH_ROOT);
                }
            }
            else
            {
                GUILayout.Label("Select Scene coordinates to convert", EditorStyles.boldLabel);
                GUILayout.Space(10);

                xCoord = EditorGUILayout.IntField("X", xCoord);
                yCoord = EditorGUILayout.IntField("Y", yCoord);
                radius = EditorGUILayout.IntField("Radius", radius);

                GUILayout.FlexibleSpace();
                if (GUILayout.Button("Start"))
                {
                    await SceneClient.DumpArea(new Vector2Int(xCoord, yCoord), new Vector2Int(radius, radius));
                    EditorUtility.RevealInFinder(Config.ASSET_BUNDLES_PATH_ROOT);
                }
            }
        }
    }
}