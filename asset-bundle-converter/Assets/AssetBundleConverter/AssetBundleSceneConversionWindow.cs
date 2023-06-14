using AssetBundleConverter.Wearables;
using System.Threading.Tasks;
using DCL;
using DCL.ABConverter;
using System;
using System.Linq;
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
        private const string URL_PEERS = "Peers";
        private const string URL_WORLDS = "Worlds";
        private const string CUSTOM = "Custom";
        private const string GOERLI_PLAZA = "Goerli Plaza";


        private const string PEERS_URL = "https://peer.decentraland.org/content/contents/";
        private const string WORLDS_URL = "https://sdk-team-cdn.decentraland.org/ipfs/";

        private readonly string[] tabs = { TAB_SCENE, TAB_PARCELS, TAB_RANDOM, TAB_WEARABLES_COLLECTION, TEST_BATCHMODE, GOERLI_PLAZA };
        private readonly string[] urlOptions = { URL_PEERS, URL_WORLDS, CUSTOM };

        private string entityId = "bafkreidsgvslvpggw234fg3bzgqbtchjgcn5daqsw4sn6qj7vyxyhci3ky";
        private string wearablesCollectionId = "urn:decentraland:off-chain:base-avatars";
        private string debugEntity = "bafkreib66ufmbowp4ee2u3kdu6t52kouie7kd7tfrlv3l5kejz6yjcaq5i";
        private string batchBaseUrl = "";
        private string batchSceneId = "";
        private string batchModeParams = "";
        private string baseUrl;
        private bool placeOnScene = false;
        private bool visualTest = false;
        private bool clearDownloads = true;
        private bool createLODs = true;
        private bool createAssetBundle = false;
        private bool verbose = true;
        private int currentTab = 0;
        private int currentUrlOption = 0;
        private int xCoord = -110;
        private int yCoord = -110;
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
            createLODs = EditorGUILayout.Toggle("Create LODs", createLODs);
            clearDownloads = EditorGUILayout.Toggle("Clear Downloads", clearDownloads);
            showDebugOptions = EditorGUILayout.Toggle("Show debug options", showDebugOptions);
            /*endPoint = EditorGUILayout.TextField("Content endpoint", endPoint);
            tld = (ContentServerUtils.ApiTLD)EditorGUILayout.EnumPopup("Top level domain", tld);*/
            shader = (ShaderType)EditorGUILayout.EnumPopup("Shader Type", shader);
            verbose = EditorGUILayout.Toggle("Verbose", verbose);
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
                        RenderGoerliPlaza();
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

        private async Task RenderGoerliPlaza()
        {
            GUILayout.FlexibleSpace();

            if (GUILayout.Button("Start"))
            {
                try
                {
                   string[] goerliEntities = new string[]
                    {
                        "bafkreihxg4soqozxlbxh4japase5bhju6f3hkuthfjgujiyufnybevbxzu",
                        "bafkreidsgvslvpggw234fg3bzgqbtchjgcn5daqsw4sn6qj7vyxyhci3ky",
                        "bafkreiao7tkc7z7xgdabge5x7oq773aru6nnwizxog33b4h276likkvklq",
                        "bafkreigy4zitbqujeudguy65s3abdoqtgqadqsnlvzmims2vkx5dtt45pe",
                        "bafkreid7jxvwq3kjyjgvrkertjf5zpiqnjx67z7s5xlfp4r7bs2imsu5cm",
                        "bafkreid27ohi4vgooyvndh6fyljrtk5vvoxutmzgwea672dvpeqo34tzlu",
                        "bafkreicntcmi7og4lq2mkb7vdxgs7om5xfo5btzj3g6cywbluhtdlaw4rm",
                        "bafkreibpzcspkbsliezrf2qlkyv4lwbuujvqyvt3kjm7mbbtqtw27mcqei",
                        "bafkreiaxn4wrabvikn42ft5pmtg7qek5v4ikoqbudpyqmbxpnlprq3mgou",
                        "bafkreih6wyle5grxdb74hvxyj7in5wdbjyhbitp7np4t5feiv3i3pdmbiu",
                        "bafkreibe6ajgmj4ik2my6urq4cvz377j2aidq2mhhnxzlhebtm4vrbjw3i",
                        "bafkreicbz2x5rt4rg3v4q2nn6rx77fa6jbdy5g4hqjbf4tr2qvtogaeb3m",
                        "bafkreica2de32634x7k4q7gizoumi74m6qnk273knztprw3jrekcatgjqm",
                        "bafkreiaay2md7aiuennasc22wcvf6zpbankj3dvxl6rvfohb7q47cdztby",
                        "bafkreiblcuhqv4kqmoiroyvtb5jtdcmw3akv6rt3udsvbrzrobe6ftdini",
                        "bafkreigjpishxqc6ksdyw4uktlgqzbxxmhwl6u2gy6miy47yrpnilwov54",
                        "bafkreiet2nkwwodoltedllmgzk45vmvmoonz4d4okzwiq6nuhbjgcey3xi",
                        "bafkreicuroqwlsininkdcnrjqgpwoyokmrctlxntoqsandzu5addmfygse",
                        "bafkreid6z2kzmgeypk57e37avazx7pxu76buylm4ff4hpv6uoy73pkqyoe",
                        "bafkreibvvefuukelu5lvaaapbx5lbwzytzuco6om235gzwfl4672z6ci4e",
                        "bafkreidvb4jvwnr3xckz3b5vkppmz5wxfzxqvozfnbwwu4llxilhjvaavy",
                        "bafkreiaqoquts5ysd4st6blramaoopdufsikiub3rq3gtcdwcvehkzv7lq",
                        "bafkreig6iwbi24xjib7c3fjntz2cwhrm3sodj3jemf6tgiasjdkvm7w6s4",
                        "bafkreibvygr7t3velqb767baa7nvdmsxrrv3t4qwmvytoo5ehgdo2snez4",
                        "bafkreibd7e3ajl4ausrkkcao2v2novzt2g3bbfyraxhvgv2g2vmita7vqy",
                        "bafkreigtzyuchoogsvc5pubklbh4jd3vhhaav3ayvimdt47fwg624ji6zm",
                        "bafkreigvhvdmssmxh2lk43wxjgg4opb7hjbzxzxbp2xqivzjudzk5uswl4",
                        "bafkreidf23lemxg2qyhrlppldr4zu54g5jgejyxcvogqghaoq43qbyi5pu",
                        "bafkreihscz4m2hn7avobblgmtny5a745xv25izjdw6bovpq76q3yjy65wq",
                        "bafkreiet5svfmhsp46dnmm2fgbfxpuphq7zskw3vcbbiy3ktaz4dfwlngy",
                        "bafkreihly4bhyjqujoj44vb57ux3h4ghoqarroockez6zxmph6jkogadju",
                        "bafkreiccqmqbftfgcywt5ikau2p5a4xgvipf5hwoopnmvo3zdkmwa2tm3e",
                        "bafkreiarerj3maknnf75zmuovkafruvhej5idq233xesfi4nykmhtgbj6m",
                        "bafkreigor7zo5zzgd3f6u4octcbwpoidoxq7zgh5xkbiusmdhrvxoyklli",
                        "bafkreifd7s25ow56w2r23gnbae7mhapynffyqejdptkudhkxtsfq7rz2y4",
                        "bafkreiekrssojlh5jgucgc3stytzqnwb3wizuudnvceq3c34h3sfsni3iq",
                        "bafkreicxm76exsn6l6ajgniu5zmn3mtdihj4hbprgys46jbeksczo4pqve",
                        "bafkreigaywv5cgndbfixtatevflvvkwjdavqaldrvbdficdxdecktimhym",
                        "bafkreiet4ryknyygjvnspmjkcifuxkkkpwhumn4rzli2nbkwbq47y42wae",
                        "bafkreibo73aqe6p2p4nlbfkcbnsefidfakgaeepsevsrp7iiyrcqsuifoq",
                        "bafkreidwvc74ozj5im26nxzuxrzty3ricusguzvhttwbpkczhpqdetjnpm",
                        "bafkreiey7bf7nfie2cog43yimkj6i2od57uh3couletzjuqixpx6gt3ox4"
                    };

                   var state = new DCL.ABConverter.AssetBundleConverter.State();
                   SetupSettings();
                   clientSettings.baseUrl = "https://sdk-team-cdn.decentraland.org/ipfs/";
                   for (int i = 0; i < goerliEntities.Length; i++)
                   {
                       clientSettings.targetHash = goerliEntities[i];
                       state = await SceneClient.ConvertEntityById(clientSettings);
                       clientSettings.clearDirectoriesOnStart = false;
                   }
                   OnConversionEnd(state);
                   clientSettings.clearDirectoriesOnStart = true;
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
                    var state = await SceneClient.ConvertEntityById(clientSettings);
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
                clientSettings.targetHash = wearablesCollectionId;
                try
                {
                    var state = await SceneClient.ConvertWearablesCollection(clientSettings);
                    OnConversionEnd(state);
                }
                catch (Exception e) { Debug.LogException(e); }
            }
        }

        private void SetupSettings()
        {
            clientSettings = new ClientSettings
            {
                visualTest = visualTest,
                baseUrl = baseUrl,
                cleanAndExitOnFinish = false,
                createAssetBundle = createAssetBundle,
                createLODs = createLODs,
                clearDirectoriesOnStart = clearDownloads,
                importOnlyEntity = showDebugOptions ? debugEntity : "",
                shaderType = shader,
                stripShaders = stripShaders,
                importGltf = importGltf,
                placeOnScene = placeOnScene,
                verbose = verbose
            };
        }

        private void OnConversionEnd(DCL.ABConverter.AssetBundleConverter.State state)
        {
            if (createAssetBundle && state.lastErrorCode == DCL.ABConverter.AssetBundleConverter.ErrorCodes.SUCCESS)
                EditorUtility.RevealInFinder(Config.ASSET_BUNDLES_PATH_ROOT);
        }
    }
}
