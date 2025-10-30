using System;
using UnityEngine;
using UnityEditor;
using XAtlasWrapper;
using System.Collections.Generic;

public class XAtlasWindow : EditorWindow
{
    private Vector2 scrollPosition;
    private XAtlasGenerator generator = new XAtlasGenerator();

    // Input
    private List<GameObject> sourceMeshes = new List<GameObject>();

    // Chart Options
    private float maxChartArea = 0f;
    private float maxBoundaryLength = 0f;
    private float normalDeviationWeight = 2.0f;
    private float roundnessWeight = 0.01f;
    private float straightnessWeight = 6.0f;
    private float normalSeamWeight = 4.0f;
    private float textureSeamWeight = 0.5f;
    private float maxCost = 2.0f;
    private int maxIterations = 1;
    private bool useInputMeshUvs = false;
    private bool fixWinding = false;

    // Pack Options
    private int maxChartSize = 0;
    private int padding = 2;
    private float texelsPerUnit = 0f;
    private int resolution = 1024;
    private bool bilinear = true;
    private bool blockAlign = false;
    private bool bruteForce = false;
    private bool createImage = true;
    private bool rotateChartsToAxis = true;
    private bool rotateCharts = true;

    // Resolution Calculator
    private bool autoCalculateResolution = true;
    private float sourceTextureResolution = 1024f;
    private float estimatedWorldSize = 10f;

    // Output
    private string outputPath = "Assets/GeneratedAtlases/";
    private string outputName = "Atlas";
    private bool generatePrefab = true;
    private Material atlasMaterial;

    // Progress
    private bool isProcessing = false;
    private string currentOperation = "";
    private float currentProgress = 0f;

    // Presets
    private int selectedPreset = 0;
    private string[] presetNames = { "Custom", "Fast (Low Quality)", "Balanced", "High Quality", "Maximum Quality" };

    // Two-Step Workflow
    private bool useTwoStepWorkflow = false;

    [MenuItem("Tools/XAtlas UV Generator")]
    public static void ShowWindow()
    {
        XAtlasWindow window = GetWindow<XAtlasWindow>("XAtlas UV Generator");
        window.minSize = new Vector2(400, 700);
    }

    private void OnEnable()
    {
        if (sourceMeshes == null)
            sourceMeshes = new List<GameObject>();

        generator.OnProgress = (operation, progress) =>
        {
            currentOperation = operation;
            currentProgress = progress;
            Repaint();
        };
    }

    private void OnDisable()
    {
        generator.Cleanup();
    }

    private void OnGUI()
    {
        scrollPosition = EditorGUILayout.BeginScrollView(scrollPosition);

        DrawHeader();
        DrawInputSection();
        DrawResolutionCalculator();
        DrawWorkflowSection();
        DrawPresetSection();
        DrawChartOptionsSection();
        DrawPackOptionsSection();
        DrawOutputSection();
        DrawGenerateButton();
        DrawProgressSection();

        EditorGUILayout.EndScrollView();
    }

    private void DrawHeader()
    {
        EditorGUILayout.Space(10);
        GUIStyle titleStyle = new GUIStyle(EditorStyles.boldLabel)
        {
            fontSize = 18,
            alignment = TextAnchor.MiddleCenter
        };
        EditorGUILayout.LabelField("XAtlas UV Generator", titleStyle);
        EditorGUILayout.Space(5);
        EditorGUILayout.HelpBox("Generate optimized UV atlases for your meshes using the XAtlas library.", MessageType.Info);
        EditorGUILayout.Space(10);
    }

    private void DrawInputSection()
    {
        EditorGUILayout.LabelField("Input Meshes", EditorStyles.boldLabel);
        EditorGUILayout.BeginVertical("box");

        EditorGUI.BeginDisabledGroup(generator.IsChartsGenerated);

        if (GUILayout.Button("Add Selected GameObjects", GUILayout.Height(25)))
        {
            foreach (GameObject obj in Selection.gameObjects)
            {
                if (obj.GetComponent<MeshFilter>() != null && !sourceMeshes.Contains(obj))
                {
                    sourceMeshes.Add(obj);
                }
            }
        }

        for (int i = sourceMeshes.Count - 1; i >= 0; i--)
        {
            EditorGUILayout.BeginHorizontal();
            sourceMeshes[i] = (GameObject)EditorGUILayout.ObjectField(sourceMeshes[i], typeof(GameObject), true);
            if (GUILayout.Button("X", GUILayout.Width(25)))
            {
                sourceMeshes.RemoveAt(i);
            }
            EditorGUILayout.EndHorizontal();
        }

        EditorGUI.EndDisabledGroup();

        if (sourceMeshes.Count == 0)
        {
            EditorGUILayout.HelpBox("No meshes added. Select GameObjects with MeshFilter and click 'Add Selected GameObjects'.", MessageType.Warning);
        }
        else
        {
            EditorGUILayout.LabelField($"Total meshes: {sourceMeshes.Count}", EditorStyles.miniLabel);
        }

        if (generator.IsChartsGenerated)
        {
            EditorGUILayout.HelpBox("Charts generated! Meshes locked. Reset to change input.", MessageType.Info);
        }

        EditorGUILayout.EndVertical();
        EditorGUILayout.Space(10);
    }

    private void DrawWorkflowSection()
    {
        EditorGUILayout.LabelField("Workflow Mode", EditorStyles.boldLabel);
        EditorGUILayout.BeginVertical("box");

        EditorGUI.BeginDisabledGroup(isProcessing);

        bool newTwoStepWorkflow = EditorGUILayout.Toggle("Two-Step Workflow", useTwoStepWorkflow);

        if (newTwoStepWorkflow != useTwoStepWorkflow)
        {
            if (generator.IsChartsGenerated)
            {
                if (EditorUtility.DisplayDialog("Change Workflow Mode",
                    "Changing workflow mode will reset the current charts. Continue?",
                    "Yes", "No"))
                {
                    generator.Cleanup();
                    useTwoStepWorkflow = newTwoStepWorkflow;
                }
            }
            else
            {
                useTwoStepWorkflow = newTwoStepWorkflow;
            }
        }

        EditorGUI.EndDisabledGroup();

        if (useTwoStepWorkflow)
        {
            EditorGUILayout.HelpBox(
                "Two-Step Mode: Generate charts first, then experiment with different packing settings without regenerating charts.",
                MessageType.Info);
        }
        else
        {
            EditorGUILayout.HelpBox(
                "Single-Step Mode: Generate charts and pack in one operation.",
                MessageType.Info);
        }

        if (generator.IsChartsGenerated)
        {
            EditorGUILayout.Space(5);
            EditorGUILayout.LabelField("Chart Generation Complete!", EditorStyles.miniBoldLabel);
            EditorGUILayout.LabelField($"Total Charts: {generator.CachedChartCount}");

            if (GUILayout.Button("Reset & Start Over", GUILayout.Height(30)))
            {
                generator.Cleanup();
            }
        }

        EditorGUILayout.EndVertical();
        EditorGUILayout.Space(10);
    }

    private void DrawResolutionCalculator()
    {
        EditorGUILayout.LabelField("Resolution Calculator", EditorStyles.boldLabel);
        EditorGUILayout.BeginVertical("box");

        autoCalculateResolution = EditorGUILayout.Toggle("Auto-Calculate Resolution", autoCalculateResolution);

        if (autoCalculateResolution)
        {
            EditorGUILayout.HelpBox(
                "Calculates atlas resolution to maintain the same texture density as source meshes.",
                MessageType.Info);

            sourceTextureResolution = EditorGUILayout.FloatField("Source Texture Resolution", sourceTextureResolution);
            EditorGUILayout.HelpBox("What resolution are the individual textures currently? (e.g., 1024, 2048)", MessageType.None);

            EditorGUI.BeginDisabledGroup(sourceMeshes.Count == 0);
            if (GUILayout.Button("Calculate from Selected Meshes"))
            {
                CalculateOptimalResolution();
            }
            EditorGUI.EndDisabledGroup();

            EditorGUILayout.Space(5);
            EditorGUILayout.LabelField("Calculated Settings:", EditorStyles.miniBoldLabel);
            EditorGUILayout.LabelField($"Recommended Resolution: {resolution}x{resolution}");
            EditorGUILayout.LabelField($"Texels Per Unit: {texelsPerUnit:F2}");
            EditorGUILayout.LabelField($"Total Surface Area: {estimatedWorldSize:F2} units²");
        }
        else
        {
            resolution = EditorGUILayout.IntPopup("Manual Resolution", resolution,
                new string[] { "512", "1024", "2048", "4096", "8192" },
                new int[] { 512, 1024, 2048, 4096, 8192 });
        }

        EditorGUILayout.EndVertical();
        EditorGUILayout.Space(10);
    }

    private void CalculateOptimalResolution()
    {
        float totalSurfaceArea = 0f;
        float totalCurrentTextureArea = 0f;

        foreach (GameObject obj in sourceMeshes)
        {
            MeshFilter meshFilter = obj.GetComponent<MeshFilter>();
            if (meshFilter == null || meshFilter.sharedMesh == null)
                continue;

            UnityEngine.Mesh mesh = meshFilter.sharedMesh;
            float meshSurfaceArea = CalculateMeshSurfaceArea(mesh, obj.transform);
            totalSurfaceArea += meshSurfaceArea;
            totalCurrentTextureArea += sourceTextureResolution * sourceTextureResolution;
        }

        estimatedWorldSize = totalSurfaceArea;

        if (totalSurfaceArea <= 0)
        {
            Debug.LogWarning("Could not calculate surface area. Using default values.");
            return;
        }

        float targetTexelsPerUnit = Mathf.Sqrt(totalCurrentTextureArea / totalSurfaceArea);
        texelsPerUnit = targetTexelsPerUnit;

        float requiredAtlasPixels = totalSurfaceArea * (targetTexelsPerUnit * targetTexelsPerUnit);
        int calculatedResolution = Mathf.NextPowerOfTwo((int)Mathf.Sqrt(requiredAtlasPixels));

        float packingEfficiency = 0.75f;
        calculatedResolution = Mathf.NextPowerOfTwo((int)(calculatedResolution / Mathf.Sqrt(packingEfficiency)));

        resolution = Mathf.Clamp(calculatedResolution, 512, 8192);

        Debug.Log($"Calculated optimal resolution: {resolution}x{resolution}");
        Debug.Log($"Texels per unit: {texelsPerUnit:F2}");
        Debug.Log($"Total surface area: {totalSurfaceArea:F2} units²");
    }

    private float CalculateMeshSurfaceArea(UnityEngine.Mesh mesh, Transform transform)
    {
        Vector3[] vertices = mesh.vertices;
        int[] triangles = mesh.triangles;
        float area = 0f;

        for (int i = 0; i < triangles.Length; i += 3)
        {
            Vector3 v0 = transform.TransformPoint(vertices[triangles[i]]);
            Vector3 v1 = transform.TransformPoint(vertices[triangles[i + 1]]);
            Vector3 v2 = transform.TransformPoint(vertices[triangles[i + 2]]);

            Vector3 cross = Vector3.Cross(v1 - v0, v2 - v0);
            area += cross.magnitude * 0.5f;
        }

        return area;
    }

    private void DrawPresetSection()
    {
        EditorGUILayout.LabelField("Presets", EditorStyles.boldLabel);
        EditorGUILayout.BeginVertical("box");

        EditorGUI.BeginChangeCheck();
        selectedPreset = EditorGUILayout.Popup("Quality Preset", selectedPreset, presetNames);
        if (EditorGUI.EndChangeCheck() && selectedPreset > 0)
        {
            ApplyPreset(selectedPreset);
        }

        EditorGUILayout.EndVertical();
        EditorGUILayout.Space(10);
    }

    private void DrawChartOptionsSection()
    {
        EditorGUILayout.LabelField("Chart Generation Options", EditorStyles.boldLabel);
        EditorGUILayout.BeginVertical("box");

        EditorGUI.BeginDisabledGroup(generator.IsChartsGenerated);
        EditorGUI.BeginChangeCheck();

        maxIterations = EditorGUILayout.IntSlider("Max Iterations", maxIterations, 1, 10);
        EditorGUILayout.HelpBox("Higher = better quality but slower. 1-2 recommended.", MessageType.None);

        maxCost = EditorGUILayout.Slider("Max Cost", maxCost, 0.5f, 10f);
        EditorGUILayout.HelpBox("Lower = more charts. Range: 0.5-10, default 2.0", MessageType.None);

        EditorGUILayout.Space(5);
        EditorGUILayout.LabelField("Weights", EditorStyles.miniBoldLabel);
        normalDeviationWeight = EditorGUILayout.Slider("Normal Deviation", normalDeviationWeight, 0f, 10f);
        roundnessWeight = EditorGUILayout.Slider("Roundness", roundnessWeight, 0f, 1f);
        straightnessWeight = EditorGUILayout.Slider("Straightness", straightnessWeight, 0f, 10f);
        normalSeamWeight = EditorGUILayout.Slider("Normal Seam", normalSeamWeight, 0f, 10f);
        textureSeamWeight = EditorGUILayout.Slider("Texture Seam", textureSeamWeight, 0f, 10f);

        EditorGUILayout.Space(5);
        EditorGUILayout.LabelField("Limits", EditorStyles.miniBoldLabel);
        maxChartArea = EditorGUILayout.FloatField("Max Chart Area (0 = unlimited)", maxChartArea);
        maxBoundaryLength = EditorGUILayout.FloatField("Max Boundary Length (0 = unlimited)", maxBoundaryLength);

        EditorGUILayout.Space(5);
        EditorGUILayout.LabelField("Advanced", EditorStyles.miniBoldLabel);
        useInputMeshUvs = EditorGUILayout.Toggle("Use Input Mesh UVs", useInputMeshUvs);
        fixWinding = EditorGUILayout.Toggle("Fix Winding", fixWinding);

        if (EditorGUI.EndChangeCheck())
        {
            selectedPreset = 0;
        }

        EditorGUI.EndDisabledGroup();

        if (generator.IsChartsGenerated)
        {
            EditorGUILayout.HelpBox("Charts already generated. Reset to change chart options.", MessageType.Info);
        }

        EditorGUILayout.EndVertical();
        EditorGUILayout.Space(10);
    }

    private void DrawPackOptionsSection()
    {
        EditorGUILayout.LabelField("Packing Options", EditorStyles.boldLabel);
        EditorGUILayout.BeginVertical("box");

        EditorGUI.BeginChangeCheck();

        if (!autoCalculateResolution)
        {
            resolution = EditorGUILayout.IntPopup("Atlas Resolution", resolution,
                new string[] { "512", "1024", "2048", "4096", "8192" },
                new int[] { 512, 1024, 2048, 4096, 8192 });
        }

        texelsPerUnit = EditorGUILayout.FloatField("Texels Per Unit (0 = auto)", texelsPerUnit);
        EditorGUILayout.HelpBox("Controls texture density. 0 auto-calculates based on resolution.", MessageType.None);

        padding = EditorGUILayout.IntSlider("Padding (pixels)", padding, 0, 16);
        maxChartSize = EditorGUILayout.IntField("Max Chart Size (0 = unlimited)", maxChartSize);

        EditorGUILayout.Space(5);
        EditorGUILayout.LabelField("Optimization", EditorStyles.miniBoldLabel);
        bilinear = EditorGUILayout.Toggle("Bilinear Padding", bilinear);
        blockAlign = EditorGUILayout.Toggle("Block Align (4x4)", blockAlign);
        rotateChartsToAxis = EditorGUILayout.Toggle("Rotate to Axis", rotateChartsToAxis);
        rotateCharts = EditorGUILayout.Toggle("Rotate Charts", rotateCharts);
        bruteForce = EditorGUILayout.Toggle("Brute Force (slower, better)", bruteForce);

        EditorGUILayout.Space(5);
        createImage = EditorGUILayout.Toggle("Create Atlas Image", createImage);

        if (EditorGUI.EndChangeCheck())
        {
            selectedPreset = 0;
        }

        EditorGUILayout.EndVertical();
        EditorGUILayout.Space(10);
    }

    private void DrawOutputSection()
    {
        EditorGUILayout.LabelField("Output Settings", EditorStyles.boldLabel);
        EditorGUILayout.BeginVertical("box");

        EditorGUILayout.BeginHorizontal();
        outputPath = EditorGUILayout.TextField("Output Path", outputPath);
        if (GUILayout.Button("Browse", GUILayout.Width(60)))
        {
            string path = EditorUtility.SaveFolderPanel("Select Output Folder", "Assets", "");
            if (!string.IsNullOrEmpty(path))
            {
                outputPath = "Assets" + path.Substring(Application.dataPath.Length) + "/";
            }
        }
        EditorGUILayout.EndHorizontal();

        outputName = EditorGUILayout.TextField("Output Name", outputName);
        generatePrefab = EditorGUILayout.Toggle("Generate Prefab", generatePrefab);
        atlasMaterial = (Material)EditorGUILayout.ObjectField("Atlas Material", atlasMaterial, typeof(Material), false);

        EditorGUILayout.EndVertical();
        EditorGUILayout.Space(10);
    }

    private void DrawGenerateButton()
    {
        if (useTwoStepWorkflow)
        {
            if (!generator.IsChartsGenerated)
            {
                EditorGUI.BeginDisabledGroup(isProcessing || sourceMeshes.Count == 0);

                GUIStyle buttonStyle = new GUIStyle(GUI.skin.button)
                {
                    fontSize = 14,
                    fontStyle = FontStyle.Bold,
                    fixedHeight = 40
                };

                if (GUILayout.Button("Step 1: Generate Charts", buttonStyle))
                {
                    GenerateChartsOnly();
                }

                EditorGUI.EndDisabledGroup();
            }
            else
            {
                EditorGUI.BeginDisabledGroup(isProcessing);

                GUIStyle buttonStyle = new GUIStyle(GUI.skin.button)
                {
                    fontSize = 14,
                    fontStyle = FontStyle.Bold,
                    fixedHeight = 40
                };

                if (GUILayout.Button("Step 2: Pack Charts", buttonStyle))
                {
                    PackChartsOnly();
                }

                EditorGUI.EndDisabledGroup();
            }
        }
        else
        {
            EditorGUI.BeginDisabledGroup(isProcessing || sourceMeshes.Count == 0);

            GUIStyle buttonStyle = new GUIStyle(GUI.skin.button)
            {
                fontSize = 14,
                fontStyle = FontStyle.Bold,
                fixedHeight = 40
            };

            if (GUILayout.Button("Generate UV Atlas", buttonStyle))
            {
                GenerateAtlas();
            }

            EditorGUI.EndDisabledGroup();
        }

        EditorGUILayout.Space(10);
    }

    private void DrawProgressSection()
    {
        if (isProcessing)
        {
            EditorGUILayout.BeginVertical("box");
            EditorGUILayout.LabelField("Processing...", EditorStyles.boldLabel);
            EditorGUILayout.LabelField(currentOperation);
            Rect rect = EditorGUILayout.GetControlRect(false, 20);
            EditorGUI.ProgressBar(rect, currentProgress / 100f, $"{currentProgress:F1}%");
            EditorGUILayout.EndVertical();
        }
    }

    private void ApplyPreset(int preset)
    {
        switch (preset)
        {
            case 1: // Fast
                maxIterations = 1;
                maxCost = 3.0f;
                bruteForce = false;
                normalDeviationWeight = 2.0f;
                roundnessWeight = 0.01f;
                straightnessWeight = 6.0f;
                break;

            case 2: // Balanced
                maxIterations = 1;
                maxCost = 2.0f;
                bruteForce = false;
                normalDeviationWeight = 2.0f;
                roundnessWeight = 0.01f;
                straightnessWeight = 6.0f;
                break;

            case 3: // High Quality
                maxIterations = 2;
                maxCost = 1.5f;
                bruteForce = true;
                normalDeviationWeight = 2.5f;
                roundnessWeight = 0.05f;
                straightnessWeight = 7.0f;
                break;

            case 4: // Maximum Quality
                maxIterations = 4;
                maxCost = 1.0f;
                bruteForce = true;
                normalDeviationWeight = 3.0f;
                roundnessWeight = 0.1f;
                straightnessWeight = 8.0f;
                break;
        }
    }

    private ChartOptions GetChartOptions()
    {
        XAtlasNative.xatlasChartOptionsInit(out ChartOptions chartOptions);
        chartOptions.maxChartArea = maxChartArea;
        chartOptions.maxBoundaryLength = maxBoundaryLength;
        chartOptions.normalDeviationWeight = normalDeviationWeight;
        chartOptions.roundnessWeight = roundnessWeight;
        chartOptions.straightnessWeight = straightnessWeight;
        chartOptions.normalSeamWeight = normalSeamWeight;
        chartOptions.textureSeamWeight = textureSeamWeight;
        chartOptions.maxCost = maxCost;
        chartOptions.maxIterations = (uint)maxIterations;
        chartOptions.useInputMeshUvs = useInputMeshUvs;
        chartOptions.fixWinding = fixWinding;
        return chartOptions;
    }

    private PackOptions GetPackOptions()
    {
        XAtlasNative.xatlasPackOptionsInit(out PackOptions packOptions);
        packOptions.maxChartSize = (uint)maxChartSize;
        packOptions.padding = (uint)padding;
        packOptions.texelsPerUnit = texelsPerUnit;
        packOptions.resolution = (uint)resolution;
        packOptions.bilinear = bilinear;
        packOptions.blockAlign = blockAlign;
        packOptions.bruteForce = bruteForce;
        packOptions.createImage = createImage;
        packOptions.rotateChartsToAxis = rotateChartsToAxis;
        packOptions.rotateCharts = rotateCharts;
        return packOptions;
    }

    private void GenerateChartsOnly()
    {
        isProcessing = true;
        currentProgress = 0f;

        try
        {
            ChartOptions chartOptions = GetChartOptions();
            generator.GenerateChartsOnly(sourceMeshes, chartOptions);

            EditorUtility.DisplayDialog("Charts Generated",
                $"Successfully generated UV charts!\n\n" +
                $"Total Charts: {generator.CachedChartCount}\n\n" +
                $"Now adjust packing settings and click 'Step 2: Pack Charts'", "OK");
        }
        catch (System.Exception e)
        {
            Debug.LogError($"Failed to generate charts: {e.Message}\n{e.StackTrace}");
            EditorUtility.DisplayDialog("Error", $"Failed to generate charts:\n{e.Message}", "OK");
            generator.Cleanup();
        }
        finally
        {
            isProcessing = false;
            currentOperation = "";
            currentProgress = 0f;
            Repaint();
        }
    }

    private void PackChartsOnly()
    {
        isProcessing = true;
        currentProgress = 0f;

        try
        {
            PackOptions packOptions = GetPackOptions();
            Atlas result = generator.PackChartsOnly(packOptions);

            string utilizationInfo = XAtlasGenerator.GetUtilizationString(result);

            EditorUtility.DisplayDialog("Packing Complete",
                $"Successfully packed UV atlas!\n\n" +
                $"Atlases: {result.atlasCount}\n" +
                $"Resolution: {result.width}x{result.height}\n" +
                $"Charts: {result.chartCount}\n" +
                (string.IsNullOrEmpty(utilizationInfo) ? "" : $"\nUtilization:\n{utilizationInfo}"), "OK");
        }
        catch (System.Exception e)
        {
            Debug.LogError($"Failed to pack charts: {e.Message}\n{e.StackTrace}");
            EditorUtility.DisplayDialog("Error", $"Failed to pack charts:\n{e.Message}", "OK");
        }
        finally
        {
            isProcessing = false;
            currentOperation = "";
            currentProgress = 0f;
            Repaint();
        }
    }

    private void GenerateAtlas()
    {
        isProcessing = true;
        currentProgress = 0f;

        try
        {
            ChartOptions chartOptions = GetChartOptions();
            PackOptions packOptions = GetPackOptions();

            Atlas result = generator.GenerateAtlasOneStep(sourceMeshes, chartOptions, packOptions);

            string utilizationInfo = XAtlasGenerator.GetUtilizationString(result);

            EditorUtility.DisplayDialog("Success",
                $"Successfully generated UV atlas!\n\n" +
                $"Atlases: {result.atlasCount}\n" +
                $"Resolution: {result.width}x{result.height}\n" +
                $"Charts: {result.chartCount}\n" +
                (string.IsNullOrEmpty(utilizationInfo) ? "" : $"\nUtilization:\n{utilizationInfo}"), "OK");
        }
        catch (System.Exception e)
        {
            Debug.LogError($"Failed to generate atlas: {e.Message}\n{e.StackTrace}");
            EditorUtility.DisplayDialog("Error", $"Failed to generate atlas:\n{e.Message}", "OK");
        }
        finally
        {
            isProcessing = false;
            currentOperation = "";
            currentProgress = 0f;
            Repaint();
        }
    }
}
