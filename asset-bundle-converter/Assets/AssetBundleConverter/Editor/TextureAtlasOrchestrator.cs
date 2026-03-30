using System.Collections.Generic;
using System.IO;
using System.Linq;
using AssetBundleConverter.TextureAtlas;
using UnityEditor;
using UnityEngine;

namespace AssetBundleConverter.Editor
{
    /// <summary>
    /// Orchestrates the full texture-atlas pipeline (Plan → Pack → Build → apply) for a
    /// single GLTF import pass.  Call BuildAtlases from CreateMaterialAssets after the
    /// per-material texture maps have been populated but before FixTextureReferences locks
    /// down read/write settings.
    ///
    /// Only base-colour (albedo) textures drive atlas grouping and packing.  For each group
    /// the packer produces one layout; that same layout is reused to build parallel normal-map
    /// and metallic atlases so that a single UV remap on the mesh remains correct for every
    /// texture slot simultaneously.
    ///
    /// UV remapping is skipped for any renderer whose materials would require two different
    /// atlas rects on the same UV channel (uncommon in practice).
    /// </summary>
    internal static class TextureAtlasOrchestrator
    {
        private const int ATLAS_SIZE = 2048;
        private const string ENABLED_PREF_KEY = "ASSET_BUNDLE_CONVERTER_useTextureAtlas";

        /// <summary>
        /// Whether texture atlasing is enabled. Toggled from AssetBundleSceneConversionWindow
        /// and persisted via EditorPrefs so it survives domain reloads and scripted-importer runs.
        /// </summary>
        internal static bool IsEnabled
        {
            get => EditorPrefs.GetInt(ENABLED_PREF_KEY, 1) == 1;
            set => EditorPrefs.SetInt(ENABLED_PREF_KEY, value ? 1 : 0);
        }

        // -------------------------------------------------------------------------
        // Per-material texture profile — one entry per atlasable material
        // -------------------------------------------------------------------------

        private struct MaterialTextureSet
        {
            public Material  Material;
            public Texture2D Base;     public string BaseProperty;
            public Texture2D Normal;   public string NormalProperty;    // null if absent
            public Texture2D Metallic; public string MetallicProperty;  // null if absent
            public Texture2D Emission; public string EmissionProperty;  // null if absent
        }

        // -------------------------------------------------------------------------
        // Public API
        // -------------------------------------------------------------------------

        /// <summary>
        /// Resolves duplicate textures across the full texture set, redirects all material
        /// references from duplicates to their canonical, and returns the deduplicated list.
        /// Call this on the complete per-GLTF texture list before atlasing or import-setting
        /// fixup so every downstream stage works on a collapsed, canonical set.
        /// </summary>
        internal static List<Texture2D> DeduplicateAndRedirect(
            IList<Texture2D> textures,
            Dictionary<Texture2D, List<TexMaterialMap>> texMaterialMap)
        {
            Debug.Log($"[TextureAtlas] DeduplicateAndRedirect: {textures.Count} total textures across all slots.");
            var dedup = TextureDuplicateResolver.Resolve(textures);

            if (dedup.DuplicateCount > 0)
            {
                Debug.Log($"[TextureAtlas] Dedup: {dedup.DuplicateCount} duplicate(s) collapsed → {dedup.UniqueTextures.Count} unique textures. Redirecting material refs.");
                RedirectDuplicates(textures, dedup, texMaterialMap);
            }
            else
            {
                Debug.Log($"[TextureAtlas] Dedup: no duplicates found. {dedup.UniqueTextures.Count} unique textures.");
            }

            return dedup.UniqueTextures;
        }

        /// <summary>
        /// Builds texture atlases for all base-colour candidates.  For each atlas group the
        /// same UV layout is used to build parallel normal-map and metallic atlases, so a
        /// single UV remap on each mesh remains correct for every texture slot.
        /// </summary>
        internal static void BuildAtlases(
            IList<Texture2D> baseColorTextures,
            Dictionary<Texture2D, List<TexMaterialMap>> texMaterialMap,
            Renderer[] renderers,
            string folderName)
        {
            Debug.Log($"[TextureAtlas] BuildAtlases: {baseColorTextures?.Count ?? 0} base-colour candidate(s) passed in.");

            if (baseColorTextures == null || baseColorTextures.Count < 2)
            {
                Debug.Log("[TextureAtlas] BuildAtlases: fewer than 2 candidates — skipping atlas build.");
                return;
            }

            // Build a reverse map: material → (property name → texture)
            var materialSlots = BuildMaterialSlotMap(texMaterialMap);

            // Build one MaterialTextureSet per base-colour candidate.
            // Non-POT textures are upscaled to the next POT size (planning/packing uses the POT
            // dimensions; TextureAtlasBuilder bilinear-samples into those slots automatically).
            var candidates  = new List<MaterialTextureSet>();
            var potDims     = new Dictionary<Texture2D, Vector2Int>(); // original tex → POT target dims
            foreach (var baseTex in baseColorTextures)
            {
                var set = BuildMaterialTextureSet(baseTex, texMaterialMap, materialSlots);
                if (set == null)
                {
                    Debug.LogWarning($"[TextureAtlas] '{baseTex?.name}': could not find a material using it as base colour — skipping.");
                    continue;
                }

                var s = set.Value;
                int potSize = Mathf.Max(CeilToPOT(s.Base.width), CeilToPOT(s.Base.height));
                int targW = potSize;
                int targH = potSize;

                if (targW > ATLAS_SIZE || targH > ATLAS_SIZE)
                {
                    Debug.LogWarning($"[TextureAtlas] '{s.Base.name}' ({s.Base.width}x{s.Base.height}): too large for {ATLAS_SIZE} atlas even after POT ceil ({targW}x{targH}) — skipping.");
                    continue;
                }

                bool wasUpscaled = targW != s.Base.width || targH != s.Base.height;
                if (wasUpscaled)
                    Debug.Log($"[TextureAtlas]   Candidate (non-POT → will upscale): '{s.Base.name}' {s.Base.width}x{s.Base.height} → {targW}x{targH}" +
                              $"  normal={s.Normal?.name ?? "—"}  metallic={s.Metallic?.name ?? "—"}  emission={s.Emission?.name ?? "—"}");
                else
                    Debug.Log($"[TextureAtlas]   Candidate: '{s.Base.name}' {s.Base.width}x{s.Base.height}" +
                              $"  normal={s.Normal?.name ?? "—"}  metallic={s.Metallic?.name ?? "—"}  emission={s.Emission?.name ?? "—"}");

                potDims[s.Base] = new Vector2Int(targW, targH);
                candidates.Add(s);
            }

            if (candidates.Count < 2)
            {
                Debug.Log($"[TextureAtlas] BuildAtlases: only {candidates.Count} candidate(s) after filtering — skipping atlas build.");
                return;
            }

            Debug.Log($"[TextureAtlas] BuildAtlases: {candidates.Count} candidate(s) will be atlased.");

            // Build stand-in Texture2D objects with correct POT dimensions so TextureAtlasPlanner
            // (which validates POT) sees valid inputs, then destroy them after planning.
            var planningStandins = candidates.Select(s => {
                var dims = potDims[s.Base];
                if (dims.x == s.Base.width && dims.y == s.Base.height) return s.Base;
                var t = new Texture2D(dims.x, dims.y) { name = s.Base.name };
                return t;
            }).ToList();

            var assignment = TextureAtlasPlanner.Plan(planningStandins, ATLAS_SIZE);

            // Destroy any transient stand-ins we created
            foreach (var t in planningStandins)
                if (IsTransient(t) && !candidates.Any(s => ReferenceEquals(s.Base, t)))
                    Object.DestroyImmediate(t);
            if (assignment == null)
            {
                Debug.LogError("[TextureAtlas] Planner returned null — aborting atlas build.");
                return;
            }

            Debug.Log($"[TextureAtlas] Planner: {assignment.AtlasCount} atlas group(s) for {candidates.Count} candidates.");

            string atlasDir = $"{folderName}/TextureAtlases";
            Directory.CreateDirectory(atlasDir);

            for (int g = 0; g < assignment.AtlasCount; g++)
            {
                int[] groupIndices = assignment.Groups[g];
                if (groupIndices.Length < 2)
                {
                    Debug.Log($"[TextureAtlas] Group {g}: only {groupIndices.Length} texture — skipping (need ≥ 2).");
                    continue;
                }

                var groupSets = groupIndices.Select(i => candidates[i]).ToList();
                string groupNames = string.Join(", ", groupSets.Select(s => $"'{s.Base.name}'"));
                Debug.Log($"[TextureAtlas] Group {g} ({groupSets.Count} textures): {groupNames}");

                // Pack using POT-ceiled dimensions (originals may be non-POT)
                var sizes = groupSets.Select(s => potDims[s.Base]).ToList();
                var layout = TextureAtlasPacker.Pack(sizes, ATLAS_SIZE, ATLAS_SIZE);
                if (layout == null)
                {
                    Debug.LogWarning($"[TextureAtlas] Group {g}: packer returned null — skipping.");
                    continue;
                }

                Debug.Log($"[TextureAtlas] Group {g}: packed into {layout.AtlasWidth}x{layout.AtlasHeight} atlas.");

                // --- Base colour atlas (always built) ---
                var baseTextures = groupSets.Select(s => s.Base).ToList();
                Debug.Log($"[TextureAtlas] Group {g}: making {baseTextures.Count} base texture(s) readable…");
                MakeReadable(baseTextures, true);
                var baseAtlas = SaveAtlas(
                    TextureAtlasBuilder.Build(baseTextures, layout, isLinear: false),
                    $"{atlasDir}/atlas_{g}_base.png",
                    AtlasSlot.Base);
                if (baseAtlas == null)
                {
                    Debug.LogError($"[TextureAtlas] Group {g}: failed to save base atlas — skipping group.");
                    continue;
                }
                Debug.Log($"[TextureAtlas] Group {g}: base atlas saved → '{atlasDir}/atlas_{g}_base.png'");

                // --- Normal atlas ---
                Texture2D normalAtlas = null;
                if (groupSets.Any(s => s.Normal != null))
                {
                    int withNormal = groupSets.Count(s => s.Normal != null);
                    Debug.Log($"[TextureAtlas] Group {g}: building normal atlas ({withNormal}/{groupSets.Count} have normals; rest use flat-normal placeholder).");
                    var normalTextures = groupSets.Select(s => s.Normal ?? CreateDefaultNormal()).ToList();
                    MakeReadable(normalTextures.Where(t => !IsTransient(t)).ToList(), true);
                    normalAtlas = SaveAtlas(
                        TextureAtlasBuilder.Build(normalTextures, layout, isLinear: true),
                        $"{atlasDir}/atlas_{g}_normal.png",
                        AtlasSlot.Normal);
                    Debug.Log($"[TextureAtlas] Group {g}: normal atlas {(normalAtlas != null ? "saved ✓" : "FAILED ✗")}");
                }
                else { Debug.Log($"[TextureAtlas] Group {g}: no normal maps — skipping normal atlas."); }

                // --- Metallic atlas ---
                Texture2D metallicAtlas = null;
                if (groupSets.Any(s => s.Metallic != null))
                {
                    int withMetallic = groupSets.Count(s => s.Metallic != null);
                    Debug.Log($"[TextureAtlas] Group {g}: building metallic atlas ({withMetallic}/{groupSets.Count} have metallic; rest use white placeholder).");
                    var metallicTextures = groupSets.Select(s => s.Metallic ?? CreateDefaultMetallic()).ToList();
                    MakeReadable(metallicTextures.Where(t => !IsTransient(t)).ToList(), true);
                    metallicAtlas = SaveAtlas(
                        TextureAtlasBuilder.Build(metallicTextures, layout, isLinear: true),
                        $"{atlasDir}/atlas_{g}_metallic.png",
                        AtlasSlot.Metallic);
                    Debug.Log($"[TextureAtlas] Group {g}: metallic atlas {(metallicAtlas != null ? "saved ✓" : "FAILED ✗")}");
                }
                else { Debug.Log($"[TextureAtlas] Group {g}: no metallic maps — skipping metallic atlas."); }

                // --- Emission atlas ---
                Texture2D emissionAtlas = null;
                if (groupSets.Any(s => s.Emission != null))
                {
                    int withEmission = groupSets.Count(s => s.Emission != null);
                    Debug.Log($"[TextureAtlas] Group {g}: building emission atlas ({withEmission}/{groupSets.Count} have emission; rest use black placeholder).");
                    var emissionTextures = groupSets.Select(s => s.Emission ?? CreateDefaultEmission()).ToList();
                    MakeReadable(emissionTextures.Where(t => !IsTransient(t)).ToList(), true);
                    emissionAtlas = SaveAtlas(
                        TextureAtlasBuilder.Build(emissionTextures, layout, isLinear: false),
                        $"{atlasDir}/atlas_{g}_emission.png",
                        AtlasSlot.Emission);
                    Debug.Log($"[TextureAtlas] Group {g}: emission atlas {(emissionAtlas != null ? "saved ✓" : "FAILED ✗")}");
                }
                else { Debug.Log($"[TextureAtlas] Group {g}: no emission maps — skipping emission atlas."); }

                // Map each material to its normalized UV rect within this atlas
                var materialToRect = new Dictionary<Material, Rect>(groupSets.Count);
                for (int i = 0; i < layout.SourceIndices.Length; i++)
                    materialToRect[groupSets[layout.SourceIndices[i]].Material] = layout.UVRects[i];

                ApplyToScene(groupSets, materialToRect, baseAtlas, normalAtlas, metallicAtlas, emissionAtlas, renderers);
            }
        }

        // -------------------------------------------------------------------------
        // Duplicate redirect — point materials at the canonical before planning
        // -------------------------------------------------------------------------

        private static void RedirectDuplicates(
            IList<Texture2D> candidates,
            TextureDeduplicationResult dedup,
            Dictionary<Texture2D, List<TexMaterialMap>> texMaterialMap)
        {
            for (int i = 0; i < candidates.Count; i++)
            {
                var origTex  = candidates[i];
                var canonTex = dedup.UniqueTextures[dedup.CanonicalIndices[i]];

                if (ReferenceEquals(origTex, canonTex))
                    continue;

                if (!texMaterialMap.TryGetValue(origTex, out var dupMaps))
                    continue;

                foreach (var map in dupMaps)
                {
                    map.Material.SetTexture(map.Property, canonTex);
                    map.Material.SetTextureOffset(map.Property, Vector2.zero);
                    map.Material.SetTextureScale(map.Property, Vector2.one);
                    EditorUtility.SetDirty(map.Material);
                }

                if (!texMaterialMap.TryGetValue(canonTex, out var canonMaps))
                {
                    canonMaps = new List<TexMaterialMap>();
                    texMaterialMap[canonTex] = canonMaps;
                }
                canonMaps.AddRange(dupMaps);
            }
        }

        // -------------------------------------------------------------------------
        // Scene application — update material slots then remap mesh UVs
        // -------------------------------------------------------------------------

        private static void ApplyToScene(
            List<MaterialTextureSet> groupSets,
            Dictionary<Material, Rect> materialToRect,
            Texture2D baseAtlas,
            Texture2D normalAtlas,   // may be null
            Texture2D metallicAtlas, // may be null
            Texture2D emissionAtlas, // may be null
            Renderer[] renderers)
        {
            int materialsUpdated = 0;
            foreach (var set in groupSets)
            {
                if (!materialToRect.TryGetValue(set.Material, out var rect))
                {
                    Debug.LogWarning($"[TextureAtlas] ApplyToScene: '{set.Material?.name}' has no rect in materialToRect — skipping.");
                    continue;
                }

                set.Material.SetTexture(set.BaseProperty, baseAtlas);
                set.Material.SetTextureOffset(set.BaseProperty, Vector2.zero);
                set.Material.SetTextureScale(set.BaseProperty, Vector2.one);

                if (normalAtlas != null)
                {
                    var normalProp = set.NormalProperty ?? "_BumpMap";
                    set.Material.SetTexture(normalProp, normalAtlas);
                    set.Material.SetTextureOffset(normalProp, Vector2.zero);
                    set.Material.SetTextureScale(normalProp, Vector2.one);
                }

                if (metallicAtlas != null)
                {
                    var metallicProp = set.MetallicProperty ?? "_MetallicGlossMap";
                    set.Material.SetTexture(metallicProp, metallicAtlas);
                    set.Material.SetTextureOffset(metallicProp, Vector2.zero);
                    set.Material.SetTextureScale(metallicProp, Vector2.one);
                }

                if (emissionAtlas != null)
                {
                    var emissionProp = set.EmissionProperty ?? "_EmissionMap";
                    set.Material.SetTexture(emissionProp, emissionAtlas);
                    set.Material.SetTextureOffset(emissionProp, Vector2.zero);
                    set.Material.SetTextureScale(emissionProp, Vector2.one);
                }

                Debug.Log($"[TextureAtlas] Material '{set.Material.name}' updated: " +
                          $"base={set.BaseProperty}" +
                          $"{(normalAtlas != null ? $"  normal={set.NormalProperty ?? "_BumpMap"}" : "")}" +
                          $"{(metallicAtlas != null ? $"  metallic={set.MetallicProperty ?? "_MetallicGlossMap"}" : "")}" +
                          $"{(emissionAtlas != null ? $"  emission={set.EmissionProperty ?? "_EmissionMap"}" : "")}  " +
                          $"UV rect=({rect.x:F3},{rect.y:F3} {rect.width:F3}x{rect.height:F3})");

                EditorUtility.SetDirty(set.Material);
                materialsUpdated++;
            }

            // One UV remap per renderer is now correct for all texture slots simultaneously
            int renderersRemapped = 0;
            int renderersSkipped = 0;
            foreach (var renderer in renderers)
            {
                Rect? rect = GetSingleAtlasRect(renderer.sharedMaterials, materialToRect);
                if (rect == null) { renderersSkipped++; continue; }

                Mesh mesh = GetMesh(renderer);
                if (mesh == null) { renderersSkipped++; continue; }

                Debug.Log($"[TextureAtlas] UV remap: '{renderer.name}' mesh='{mesh.name}' → rect({rect.Value.x:F3},{rect.Value.y:F3} {rect.Value.width:F3}x{rect.Value.height:F3})");
                TextureAtlasUVRemapper.RemapUVs(mesh, rect.Value);
                EditorUtility.SetDirty(mesh);
                renderersRemapped++;
            }

            Debug.Log($"[TextureAtlas] ApplyToScene done: {materialsUpdated} material(s) updated, {renderersRemapped} renderer(s) UV-remapped, {renderersSkipped} skipped.");
        }

        // -------------------------------------------------------------------------
        // Material slot map helpers
        // -------------------------------------------------------------------------

        /// Builds a reverse map: material → (property name → Texture2D)
        private static Dictionary<Material, Dictionary<string, Texture2D>> BuildMaterialSlotMap(
            Dictionary<Texture2D, List<TexMaterialMap>> texMaterialMap)
        {
            var result = new Dictionary<Material, Dictionary<string, Texture2D>>();
            foreach (var kvp in texMaterialMap)
            {
                foreach (var map in kvp.Value)
                {
                    if (!result.TryGetValue(map.Material, out var slots))
                    {
                        slots = new Dictionary<string, Texture2D>();
                        result[map.Material] = slots;
                    }
                    if (!slots.ContainsKey(map.Property))
                        slots[map.Property] = kvp.Key;
                }
            }
            return result;
        }

        /// Returns a MaterialTextureSet for the material that uses baseTex as its base colour,
        /// or null if no such material can be found in texMaterialMap.
        private static MaterialTextureSet? BuildMaterialTextureSet(
            Texture2D baseTex,
            Dictionary<Texture2D, List<TexMaterialMap>> texMaterialMap,
            Dictionary<Material, Dictionary<string, Texture2D>> materialSlots)
        {
            if (!texMaterialMap.TryGetValue(baseTex, out var maps)) return null;

            // Find the material that uses this texture in a base-colour slot
            TexMaterialMap baseMap = null;
            foreach (var m in maps)
            {
                if (IsBaseProperty(m.Property)) { baseMap = m; break; }
            }
            if (baseMap == null) return null;

            var mat = baseMap.Material;
            if (!materialSlots.TryGetValue(mat, out var slots)) return null;

            // Locate the other slots on the same material
            string normalProp = null;   Texture2D normalTex = null;
            string metallicProp = null; Texture2D metallicTex = null;
            string emissionProp = null; Texture2D emissionTex = null;

            foreach (var slot in slots)
            {
                if (normalProp == null   && IsNormalProperty(slot.Key))
                    { normalProp   = slot.Key; normalTex   = slot.Value; }
                else if (metallicProp == null && IsMetallicProperty(slot.Key))
                    { metallicProp = slot.Key; metallicTex = slot.Value; }
                else if (emissionProp == null && IsEmissionProperty(slot.Key))
                    { emissionProp = slot.Key; emissionTex = slot.Value; }
            }

            return new MaterialTextureSet
            {
                Material        = mat,
                Base            = baseTex,    BaseProperty     = baseMap.Property,
                Normal          = normalTex,   NormalProperty   = normalProp,
                Metallic        = metallicTex, MetallicProperty = metallicProp,
                Emission        = emissionTex, EmissionProperty = emissionProp,
            };
        }

        // Mirror of the property-name helpers in CustomGltfImporter
        private static bool IsBaseProperty(string p)    => p is "_BaseMap"           or "baseColorTexture";
        private static bool IsNormalProperty(string p)  => p is "_BumpMap"           or "normalTexture";
        private static bool IsMetallicProperty(string p)=> p is "_MetallicGlossMap"  or "metallicRoughnessTexture";
        private static bool IsEmissionProperty(string p)=> p is "_EmissionMap"       or "emissiveTexture";

        // -------------------------------------------------------------------------
        // UV remapping helpers
        // -------------------------------------------------------------------------

        /// Returns the one atlas rect shared by all materials on a renderer,
        /// or null if no materials are atlased or if two materials need different rects.
        private static Rect? GetSingleAtlasRect(Material[] materials, Dictionary<Material, Rect> materialToRect)
        {
            Rect? result = null;
            foreach (var mat in materials)
            {
                if (mat == null || !materialToRect.TryGetValue(mat, out var rect)) continue;
                if (result == null)      result = rect;
                else if (result.Value != rect) return null;
            }
            return result;
        }

        private static Mesh GetMesh(Renderer renderer) =>
            renderer switch
            {
                MeshRenderer     mr  => mr.GetComponent<MeshFilter>()?.sharedMesh,
                SkinnedMeshRenderer smr => smr.sharedMesh,
                _ => null
            };

        // -------------------------------------------------------------------------
        // Atlas save + import settings
        // -------------------------------------------------------------------------

        private enum AtlasSlot { Base, Normal, Metallic, Emission }

        private static Texture2D SaveAtlas(Texture2D atlas, string assetPath, AtlasSlot slot)
        {
            File.WriteAllBytes(assetPath, atlas.EncodeToPNG());
            AssetDatabase.ImportAsset(assetPath);

            var imp = AssetImporter.GetAtPath(assetPath) as TextureImporter;
            if (imp != null)
            {
                imp.mipmapEnabled = true;
                switch (slot)
                {
                    case AtlasSlot.Normal:
                        imp.textureType = TextureImporterType.NormalMap;
                        break;
                    case AtlasSlot.Metallic:
                        imp.textureType = TextureImporterType.Default;
                        imp.sRGBTexture = false;
                        break;
                    case AtlasSlot.Emission:
                        imp.textureType = TextureImporterType.Default;
                        imp.sRGBTexture = true;
                        break;
                    case AtlasSlot.Base:
                        imp.textureType = TextureImporterType.Default;
                        imp.sRGBTexture = true;
                        break;
                }
                imp.SaveAndReimport();
            }

            var loaded = AssetDatabase.LoadAssetAtPath<Texture2D>(assetPath);
            if (loaded == null)
                Debug.LogWarning($"[TextureAtlasOrchestrator] Failed to load saved atlas at '{assetPath}'.");
            return loaded;
        }

        // -------------------------------------------------------------------------
        // Default placeholder textures
        // -------------------------------------------------------------------------

        /// Flat normal map: RGB(128,128,255) encodes a (0,0,1) normal — zero displacement.
        private static Texture2D CreateDefaultNormal()
        {
            var tex = new Texture2D(1, 1, TextureFormat.RGBA32, mipChain: false, linear: true);
            tex.SetPixel(0, 0, new Color(0.5f, 0.5f, 1f, 1f));
            tex.Apply();
            return tex;
        }

        /// White metallic placeholder: treated as fully metallic / full smoothness by default.
        private static Texture2D CreateDefaultMetallic()
        {
            var tex = new Texture2D(1, 1, TextureFormat.RGBA32, mipChain: false, linear: true);
            tex.SetPixel(0, 0, Color.white);
            tex.Apply();
            return tex;
        }

        /// Black emission placeholder: no emission contribution.
        private static Texture2D CreateDefaultEmission()
        {
            var tex = new Texture2D(1, 1, TextureFormat.RGBA32, mipChain: false, linear: false);
            tex.SetPixel(0, 0, Color.black);
            tex.Apply();
            return tex;
        }

        /// True for runtime-created textures that have no disk asset and are always CPU-readable.
        private static bool IsTransient(Texture2D tex) =>
            string.IsNullOrEmpty(AssetDatabase.GetAssetPath(tex));

        /// Returns the smallest power-of-two >= n (minimum 1).
        private static int CeilToPOT(int n)
        {
            if (n <= 1) return 1;
            int p = 1;
            while (p < n) p <<= 1;
            return p;
        }

        // -------------------------------------------------------------------------
        // Texture readability helpers
        // -------------------------------------------------------------------------

        /// Enables CPU read access for textures that have a disk asset path.
        /// Textures already in the requested state are skipped to avoid redundant reimports.
        private static void MakeReadable(IList<Texture2D> textures, bool readable)
        {
            foreach (var tex in textures)
            {
                string path = AssetDatabase.GetAssetPath(tex);
                if (string.IsNullOrEmpty(path)) { Debug.Log($"[TextureAtlas] MakeReadable: '{tex?.name}' has no asset path (transient) — skipping."); continue; }

                var imp = AssetImporter.GetAtPath(path) as TextureImporter;
                if (imp == null) { Debug.LogWarning($"[TextureAtlas] MakeReadable: no TextureImporter at '{path}' — '{tex.name}' will remain unreadable."); continue; }
                if (imp.isReadable == readable) continue;

                Debug.Log($"[TextureAtlas] MakeReadable: '{tex.name}' at '{path}' → isReadable={readable}");
                imp.isReadable = readable;
                imp.SaveAndReimport();
            }
        }
    }
}
