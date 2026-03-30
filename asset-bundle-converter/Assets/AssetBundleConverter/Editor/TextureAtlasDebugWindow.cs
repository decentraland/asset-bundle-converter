using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text;
using AssetBundleConverter.TextureAtlas;
using UnityEditor;
using UnityEngine;

namespace AssetBundleConverter.Editor
{
    /// <summary>
    /// Step-by-step debug window for the texture atlas pipeline.
    /// Each pipeline module can be run independently so failures can be pinpointed.
    /// Open via Decentraland > Texture Atlas Debugger.
    /// </summary>
    public class TextureAtlasDebugWindow : EditorWindow
    {
        // ─── Pipeline state ──────────────────────────────────────────────────────

        private List<Texture2D> _collected;
        private TextureDeduplicationResult _dedupResult;
        private List<Texture2D> _uniqueTextures;           // candidates accepted for atlasing
        private Dictionary<Texture2D, Vector2Int> _potDims; // original tex → POT-ceiled target dims
        private TextureAtlasAssignment _plan;
        private List<TextureAtlasLayout> _layouts;         // one per group
        private List<Texture2D> _builtAtlases;             // one per group (base colour only for debug)

        // ─── UI state ────────────────────────────────────────────────────────────

        private DefaultAsset _sourceFolder;
        private string _outputFolder = "Assets/TextureAtlasDebug";
        private Vector2 _scroll;
        private string _log = "";

        private const int ATLAS_SIZE = 2048;

        // ─── Menu item ───────────────────────────────────────────────────────────

        [MenuItem("Decentraland/Texture Atlas Debugger")]
        private static void Open()
        {
            var win = GetWindow<TextureAtlasDebugWindow>("Atlas Debugger");
            win.minSize = new Vector2(400, 500);
            win.Show();
        }

        // ─── GUI ─────────────────────────────────────────────────────────────────

        private void OnGUI()
        {
            GUILayout.Label("Texture Atlas Debug Pipeline", EditorStyles.boldLabel);
            GUILayout.Space(4);

            _sourceFolder = (DefaultAsset)EditorGUILayout.ObjectField(
                "Source Folder", _sourceFolder, typeof(DefaultAsset), false);

            _outputFolder = EditorGUILayout.TextField("Output Folder", _outputFolder);

            GUILayout.Space(8);

            DrawStep("1. Collect Textures",
                "Find all Texture2D assets in the source folder.",
                _collected != null ? $"{_collected.Count} textures found" : null,
                StepCollect,
                _sourceFolder != null);

            DrawStep("2. Deduplicate",
                "Group textures by content hash, collapse duplicates.",
                _dedupResult != null
                    ? $"{_dedupResult.UniqueTextures.Count} unique  |  {_dedupResult.DuplicateCount} duplicates"
                    : null,
                StepDeduplicate,
                _collected != null);

            DrawStep("3. Plan Groups",
                "Assign POT textures to atlas bins using First Fit Decreasing.",
                _plan != null
                    ? $"{_plan.AtlasCount} atlas(es)  |  groups: [{string.Join(", ", _plan.Groups.Select(g => g.Length.ToString()))}]"
                    : null,
                StepPlan,
                _dedupResult != null);

            DrawStep("4. Pack Groups",
                "Run guillotine packer per group; produce UV layouts.",
                _layouts != null ? $"{_layouts.Count} layout(s)" : null,
                StepPack,
                _plan != null);

            DrawStep("5. Build Atlases",
                "Blit source textures into atlas pixel buffers.",
                _builtAtlases != null ? $"{_builtAtlases.Count} atlas texture(s) built in memory" : null,
                StepBuild,
                _layouts != null);

            DrawStep("6. Save Atlases",
                "Write atlas textures to disk as PNG assets.",
                null,
                StepSave,
                _builtAtlases != null && _builtAtlases.Count > 0);

            GUILayout.Space(8);

            if (GUILayout.Button("Reset All"))
                ResetState();

            GUILayout.Space(4);
            GUILayout.Label("Log", EditorStyles.boldLabel);
            _scroll = EditorGUILayout.BeginScrollView(_scroll, GUILayout.ExpandHeight(true));
            EditorGUILayout.TextArea(_log, GUILayout.ExpandHeight(true));
            EditorGUILayout.EndScrollView();
        }

        private static void DrawStep(string label, string description, string result, System.Action action, bool enabled)
        {
            EditorGUI.BeginDisabledGroup(!enabled);
            EditorGUILayout.BeginVertical(EditorStyles.helpBox);

            EditorGUILayout.BeginHorizontal();
            GUILayout.Label(label, EditorStyles.boldLabel);
            GUILayout.FlexibleSpace();
            if (GUILayout.Button("Run", GUILayout.Width(60)))
                action?.Invoke();
            EditorGUILayout.EndHorizontal();

            GUILayout.Label(description, EditorStyles.miniLabel);

            if (!string.IsNullOrEmpty(result))
            {
                Color prev = GUI.color;
                GUI.color = Color.cyan;
                GUILayout.Label(result, EditorStyles.miniLabel);
                GUI.color = prev;
            }

            EditorGUILayout.EndVertical();
            EditorGUI.EndDisabledGroup();
            GUILayout.Space(2);
        }

        // ─── Pipeline steps ───────────────────────────────────────────────────────

        private void StepCollect()
        {
            _collected = null;
            _dedupResult = null;
            _uniqueTextures = null;
            _plan = null;
            _layouts = null;
            _builtAtlases = null;

            if (_sourceFolder == null)
            {
                Log("No source folder selected.");
                return;
            }

            string folderPath = AssetDatabase.GetAssetPath(_sourceFolder);
            string[] guids = AssetDatabase.FindAssets("t:Texture2D", new[] { folderPath });

            _collected = new List<Texture2D>(guids.Length);
            var sb = new StringBuilder();

            foreach (string guid in guids)
            {
                string assetPath = AssetDatabase.GUIDToAssetPath(guid);
                var importer = AssetImporter.GetAtPath(assetPath);

                if (importer == null)
                {
                    sb.AppendLine($"  WARN: no importer for '{assetPath}'");
                }
                else if (importer is TextureImporter texImp)
                {
                    if (!texImp.isReadable)
                    {
                        // Evict the stale cached object before reimporting, otherwise
                        // LoadAssetAtPath returns the old non-readable instance.
                        var stale = AssetDatabase.LoadAssetAtPath<Texture2D>(assetPath);
                        if (stale != null) Resources.UnloadAsset(stale);

                        texImp.isReadable = true;
                        AssetDatabase.ImportAsset(assetPath, ImportAssetOptions.ForceSynchronousImport);
                        sb.AppendLine($"  Made readable (was not): '{assetPath}'");
                    }
                    else
                    {
                        sb.AppendLine($"  Already readable: '{assetPath}'");
                    }
                }
                else
                {
                    sb.AppendLine($"  WARN: importer is {importer.GetType().Name}, not TextureImporter — '{assetPath}'");
                }

                var tex = AssetDatabase.LoadAssetAtPath<Texture2D>(assetPath);
                if (tex != null)
                {
                    sb.AppendLine($"    Loaded: '{tex.name}'  {tex.width}x{tex.height}  isReadable={tex.isReadable}");
                    _collected.Add(tex);
                }
                else
                {
                    sb.AppendLine($"    WARN: LoadAssetAtPath returned null for '{assetPath}'");
                }
            }

            sb.Insert(0, $"[Collect] Found {guids.Length} guid(s) in '{folderPath}'\n");
            Log(sb.ToString());
            Repaint();
        }

        private void StepDeduplicate()
        {
            _dedupResult = null;
            _uniqueTextures = null;
            _plan = null;
            _layouts = null;
            _builtAtlases = null;

            _dedupResult = TextureDuplicateResolver.Resolve(_collected);

            var sb = new StringBuilder();
            sb.AppendLine($"[Deduplicate] {_dedupResult.UniqueTextures.Count} unique, {_dedupResult.DuplicateCount} duplicates removed.");
            for (int i = 0; i < _collected.Count; i++)
            {
                int canonical = _dedupResult.CanonicalIndices[i];
                if (canonical != i)
                    sb.AppendLine($"  Duplicate: '{_collected[i].name}' → canonical '{_dedupResult.UniqueTextures[canonical].name}'");
            }

            Log(sb.ToString());
            Repaint();
        }

        private void StepPlan()
        {
            _plan = null;
            _layouts = null;
            _builtAtlases = null;
            _potDims = new Dictionary<Texture2D, Vector2Int>();

            // Accept any texture whose POT-ceiled dimensions fit in the atlas
            _uniqueTextures = new List<Texture2D>();
            int skipped = 0;
            var sb = new StringBuilder();
            sb.AppendLine("[Plan] Evaluating candidates…");

            foreach (var t in _dedupResult.UniqueTextures)
            {
                if (t == null) { skipped++; continue; }
                int potSize = Mathf.Max(CeilToPOT(t.width), CeilToPOT(t.height));
                int targW = potSize;
                int targH = potSize;
                if (targW > ATLAS_SIZE || targH > ATLAS_SIZE)
                {
                    sb.AppendLine($"  SKIP (oversized): '{t.name}'  {t.width}x{t.height} → would be {targW}x{targH}");
                    skipped++;
                    continue;
                }
                if (targW != t.width || targH != t.height)
                    sb.AppendLine($"  UPSCALE: '{t.name}'  {t.width}x{t.height} → {targW}x{targH}");
                _potDims[t] = new Vector2Int(targW, targH);
                _uniqueTextures.Add(t);
            }

            sb.AppendLine($"  {_uniqueTextures.Count} candidate(s), {skipped} skipped (oversized/null).");

            // Create POT stand-ins so the planner's POT validation passes
            var standins = _uniqueTextures.Select(t =>
            {
                var d = _potDims[t];
                if (d.x == t.width && d.y == t.height) return t;
                return new Texture2D(d.x, d.y) { name = t.name };
            }).ToList();

            _plan = TextureAtlasPlanner.Plan(standins, ATLAS_SIZE);

            // Destroy any temporary stand-ins
            for (int i = 0; i < standins.Count; i++)
                if (!ReferenceEquals(standins[i], _uniqueTextures[i]))
                    DestroyImmediate(standins[i]);

            if (_plan == null)
            {
                sb.AppendLine("  Planner returned null — check Console for validation errors.");
                Log(sb.ToString());
                Repaint();
                return;
            }

            for (int g = 0; g < _plan.AtlasCount; g++)
            {
                sb.AppendLine($"  Group {g}: {_plan.Groups[g].Length} texture(s)");
                foreach (int idx in _plan.Groups[g])
                {
                    var t = _uniqueTextures[idx];
                    var d = _potDims[t];
                    string upscaleNote = (d.x != t.width || d.y != t.height) ? $" → {d.x}x{d.y}" : "";
                    sb.AppendLine($"    [{idx}] '{t.name}'  {t.width}x{t.height}{upscaleNote}");
                }
            }

            Log(sb.ToString());
            Repaint();
        }

        private void StepPack()
        {
            _layouts = null;
            _builtAtlases = null;

            _layouts = new List<TextureAtlasLayout>();
            var sb = new StringBuilder();
            sb.AppendLine($"[Pack] Packing {_plan.AtlasCount} group(s)…");

            for (int g = 0; g < _plan.AtlasCount; g++)
            {
                int[] groupIndices = _plan.Groups[g];
                // Use POT-ceiled dimensions for packing
                var sizes = groupIndices.Select(i => _potDims[_uniqueTextures[i]]).ToList();
                var layout = TextureAtlasPacker.Pack(sizes, ATLAS_SIZE, ATLAS_SIZE);

                if (layout == null)
                {
                    sb.AppendLine($"  Group {g}: PACK FAILED — skipping.");
                    _layouts.Add(null);
                    continue;
                }

                _layouts.Add(layout);
                sb.AppendLine($"  Group {g}: atlas {layout.AtlasWidth}x{layout.AtlasHeight}, {layout.UVRects.Length} rects");
                for (int r = 0; r < layout.UVRects.Length; r++)
                {
                    var rect = layout.UVRects[r];
                    int srcIdx = groupIndices[layout.SourceIndices[r]];
                    sb.AppendLine($"    Rect[{r}] src='{_uniqueTextures[srcIdx].name}'  UV({rect.x:F4},{rect.y:F4} {rect.width:F4}x{rect.height:F4})");
                }
            }

            Log(sb.ToString());
            Repaint();
        }

        private void StepBuild()
        {
            _builtAtlases = null;
            _builtAtlases = new List<Texture2D>();
            var sb = new StringBuilder();
            sb.AppendLine($"[Build] Building {_plan.AtlasCount} atlas texture(s)…");

            for (int g = 0; g < _plan.AtlasCount; g++)
            {
                var layout = _layouts[g];
                if (layout == null)
                {
                    sb.AppendLine($"  Group {g}: no layout, skipping.");
                    _builtAtlases.Add(null);
                    continue;
                }

                int[] groupIndices = _plan.Groups[g];

                // Textures were made readable at collect time — use references directly.
                var textures = groupIndices.Select(i => _uniqueTextures[i]).ToList();

                var atlas = TextureAtlasBuilder.Build(textures, layout, isLinear: false);
                _builtAtlases.Add(atlas);
                sb.AppendLine($"  Group {g}: built {atlas.width}x{atlas.height} atlas ({atlas.format})");
            }

            Log(sb.ToString());
            Repaint();
        }

        private void StepSave()
        {
            if (!Directory.Exists(_outputFolder))
                Directory.CreateDirectory(_outputFolder);

            var sb = new StringBuilder();
            sb.AppendLine($"[Save] Writing atlases to '{_outputFolder}'…");

            for (int g = 0; g < _builtAtlases.Count; g++)
            {
                var atlas = _builtAtlases[g];
                if (atlas == null)
                {
                    sb.AppendLine($"  Group {g}: no atlas to save.");
                    continue;
                }

                string path = $"{_outputFolder}/debug_atlas_{g}.png";
                File.WriteAllBytes(path, atlas.EncodeToPNG());
                AssetDatabase.ImportAsset(path);
                sb.AppendLine($"  Group {g}: saved to '{path}'");
            }

            AssetDatabase.Refresh();
            Log(sb.ToString());
            Repaint();
        }

        // ─── Helpers ──────────────────────────────────────────────────────────────

        private void ResetState()
        {
            _collected = null;
            _dedupResult = null;
            _uniqueTextures = null;
            _potDims = null;
            _plan = null;
            _layouts = null;
            _builtAtlases = null;
            _log = "";
            Repaint();
        }

        private static int CeilToPOT(int n)
        {
            if (n <= 1) return 1;
            int p = 1;
            while (p < n) p <<= 1;
            return p;
        }


        private void Log(string message)
        {
            _log = message + "\n" + _log;
            Debug.Log(message);
        }
    }
}
