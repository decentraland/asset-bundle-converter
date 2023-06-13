using System.Collections.Generic;
using System.Linq;
using System.Text.RegularExpressions;
using UnityEditor;
using UnityEditor.PixyzCommons.Extensions;
using UnityEditor.PixyzPlugin4Unity.Toolbox;
using UnityEngine;
using UnityEditor.PixyzPlugin4Unity.UI;
using UnityEngine.PixyzCommons.Extensions;
using UnityEngine.PixyzCommons.Processing;
using UnityEngine.PixyzPlugin4Unity.Licensing;
using UnityEditor.PixyzCommons.Extensions;
/*
public class DCLMerge : PixyzFunction {

    public override int id { get { return 639049607;} }
    public override string menuPathRuleEngine { get { return "DCL/DCL Merge";} }
    public override string menuPathToolbox { get { return null;} }
    public override string tooltip { get { return "DCL Merge";} }

     public override bool updateStats => mergeByRegions();

        #region parameters

        bool mergingByHierarchy() => type == Merge.MergeMode.MergeHierarchyLevel;
        bool mergingParent() => type == Merge.MergeMode.MergeAll;


        [UserParameter(tooltip: ToolboxTooltips.mergeType)]
        public Merge.MergeMode type;

        [UserParameter("mergingByHierarchy")]
        public int hierarchyLevel = 1;

        [UserParameter("mergingParent", tooltip: ToolboxTooltips.mergeKeepParent)]
        public bool keepParent = false;


        #region parameters merge by regions
        bool mergeByRegions() => type == Merge.MergeMode.MergeByRegions;
        bool mergeByNumberOfRegions() => mergeByRegions() && mergeByRegionsStrategy == MergeByRegionsStrategy.NumberOfRegions;
        bool mergeBySizeOfRegions() => mergeByRegions() && mergeByRegionsStrategy == MergeByRegionsStrategy.SizeOfRegions;

        public enum MergeStrategy
        {
            MergeGameObjects,
            MergeByMaterials
        }

        public enum MergeByRegionsStrategy
        {
            NumberOfRegions,
            SizeOfRegions
        }

        [UserParameter("mergeByRegions", displayName:"Merge By", tooltip: ToolboxTooltips.mergeByRegionsMode)]
        public MergeByRegionsStrategy mergeByRegionsStrategy = MergeByRegionsStrategy.NumberOfRegions;

        [UserParameter("mergeByNumberOfRegions", tooltip: ToolboxTooltips.numberOfRegions)]
        public int numberOfRegions = 10;

        [UserParameter("mergeBySizeOfRegions", tooltip: ToolboxTooltips.sizeOfRegions)]
        public float sizeOfRegions = 10;

        [UserParameter("mergeByRegions", tooltip: ToolboxTooltips.mergeStrategy)]
        public MergeStrategy mergeStrategy = MergeStrategy.MergeByMaterials;

        private Pixyz.Scene.Native.OccurrenceList _outputOccurrence = null;

        #endregion
        #endregion

        #region action
        public override bool preProcess(IList<GameObject> input, bool childrenIncluded = false)
        {
            Plugin4UnityProduct.API.Core.PushAnalytic("Merge", type.ToString());
            switch (type)
            {
                case Merge.MergeMode.MergeByRegions:
                    return base.preProcess(input, childrenIncluded);
                default:
                    _input = input;
                    _output = _input;
                    break;
            }

            return true;
        }

        private string[] _outputNames; // We'll use this to reconstruct objects
        protected override void process()
        {
            if (type != Merge.MergeMode.MergeByRegions)
                return; // Done Unity side

            try
            {
                uint root = Plugin4UnityProduct.API.Scene.GetRoot();
                Pixyz.Scene.Native.OccurrenceList occurrenceList = new Pixyz.Scene.Native.OccurrenceList(new uint[] { root });

                UpdateProgressBar(0.25f);

                Pixyz.Polygonal.Native.TopologyCategoryMask topologyCategoryMask = new Pixyz.Polygonal.Native.TopologyCategoryMask();
                topologyCategoryMask.connectivity = Pixyz.Polygonal.Native.TopologyConnectivityMask.BOUNDARY_NONMANIFOLD;
                topologyCategoryMask.dimension = Pixyz.Polygonal.Native.TopologyDimensionMask.FACE;
                Plugin4UnityProduct.API.Algo.MergeVertices(occurrenceList, 0.0000001, topologyCategoryMask);

                UpdateProgressBar(0.35f);

                var mergeByRegionsParameters = new Pixyz.Scene.Native.MergeByRegionsStrategy();
                mergeByRegionsParameters._type = mergeByNumberOfRegions() ? Pixyz.Scene.Native.MergeByRegionsStrategy.Type.NUMBEROFREGIONS : Pixyz.Scene.Native.MergeByRegionsStrategy.Type.SIZEOFREGIONS;
                mergeByRegionsParameters.NumberOfRegions = numberOfRegions;
                mergeByRegionsParameters.SizeOfRegions = sizeOfRegions;

                _outputOccurrence = Plugin4UnityProduct.API.Scene.MergeByRegions(occurrenceList, mergeByRegionsParameters, (Pixyz.Scene.Native.MergeStrategy)mergeStrategy);

                // Remove unnecessary patches
                Plugin4UnityProduct.API.Algo.DeletePatches(_outputOccurrence, true);

                // A hierarchy is created by NativeInterface.MergeByRegions, bake transforms directly into the meshes to avoid transformations issues
                Plugin4UnityProduct.API.Scene.ResetTransform(root, true, true, false);

                // Used in post process
                _outputNames = Plugin4UnityProduct.API.Core.GetProperties(new Pixyz.Core.Native.EntityList(_outputOccurrence), "Name", "");

                UpdateProgressBar(0.9f, "Post processing...");
            }
            catch (System.Exception e)
            {
                Debug.LogError($"[Error] {e.Message} \n {e.StackTrace}");
            }
        }

        protected override void postProcess()
        {
            base.postProcess();

            switch (type)
            {
                case Merge.MergeMode.MergeAll:
                    //Undo.RegisterFullObjectHierarchyUndo(_input.GetHighestAncestor(), "Merge");
                    _output = MergeAll(_input).ToList();
                    break;
                case Merge.MergeMode.MergeFinalLevel:
                    _output = MergeFinalLevel(_input).ToList();
                    break;
                case Merge.MergeMode.MergeByNames:
                    _output = MergeByNames(_input).ToList();
                    break;
                case Merge.MergeMode.MergeHierarchyLevel:
                    _output = MergeHierarchyLevel(_input).ToList();
                    break;
                case Merge.MergeMode.MergeByMaterials:
                    _output = MergeByMaterials(_input).ToList();
                    break;
                case Merge.MergeMode.MergeByRegions:
                    _output = PostProcessMergeByRegions();
                    break;
                default:
                    break;
            }
            UpdateProgressBar(1f, "Post processing...");
        }

        private IList<GameObject> MergeAll(IList<GameObject> input)
        {
            if (keepParent)
            {
                // Merge selected assemblies one by one (highest common ancestors)
                var highestSelectedAncestors = input.GetHighestAncestors();
                foreach (GameObject gameObject in highestSelectedAncestors)
                {
                    gameObject.MergeChildren();
                }
                return highestSelectedAncestors.ToArray();
            }
            else
            {
                // Merge all together
                return new GameObject[] { input.MergeAndCreateNewMaterials() };
            }
        }

        private IList<GameObject> MergeFinalLevel(IList<GameObject> input)
        {
            List<GameObject> finalAssemblies = new List<GameObject>();

            // Could be improved to be more efficient (parse tree in depth)
            foreach (GameObject g in input)
            {
                if (isFinalAssembly(g) && !finalAssemblies.Contains(g))
                {
                    finalAssemblies.Add(g);
                }
            }

            foreach (GameObject finalAssembly in finalAssemblies)
            {
                finalAssembly.MergeChildren();
            }

            // Get output gameobjects to display correctly process info
            var output = from g in input where g != null select g;
            return output.ToList();
        }

        /// <summary>
        /// Return true if a GameObject is a "Final Part":
        /// * Does not contain any children
        /// * Has a mesh
        /// </summary>
        /// <param name="g"></param>
        /// <returns></returns>
        private bool isFinalPart(GameObject g)
        {
            if (g.GetChildren(false, false).Count > 0) return false;
            if (g.GetComponent<MeshRenderer>() == null) return false;
            return true;
        }

        /// <summary>
        /// Return true if a GameObject is a "Final Assembly":
        /// * Has children
        /// * Contains only "Final Part" as children
        /// </summary>
        /// <param name="g"></param>
        /// <returns></returns>
        bool isFinalAssembly(GameObject g)
        {
            var children = g.GetChildren(false, false);
            if (children.Count == 0) return false;
            foreach (var child in children)
            {
                if (!isFinalPart(child)) return false;
            }
            return true;
        }

        /// <summary>
        /// Merge n-level bellow input
        /// </summary>
        /// <param name="input"></param>
        /// <returns></returns>
        private IList<GameObject> MergeHierarchyLevel(IList<GameObject> input)
        {
            // Level is relative to input (not to scene root)
            // Level should be above 1
            if (hierarchyLevel < 1) hierarchyLevel = 1;

            var highestCommonAncestors = SceneExtensions.GetHighestAncestors(input);
            foreach (GameObject assembly in highestCommonAncestors)
            {
                MergeHierarchyLevelRecursively(assembly, 1);
            }

            // Get output gameobjects to display correctly process info
            var output = from g in input where g != null select g;
            return output.ToList();
        }

        private void MergeHierarchyLevelRecursively(GameObject g, int currentLevel)
        {
            if (currentLevel == hierarchyLevel)
            {
                g.MergeChildren();
                return;
            }
            currentLevel++;
            foreach (GameObject child in g.GetChildren(false, false))
                MergeHierarchyLevelRecursively(child, currentLevel);
        }

        private IList<GameObject> MergeByNames(IList<GameObject> input)
        {
            Dictionary<string, List<GameObject>> namesDict = new Dictionary<string, List<GameObject>>();

            foreach (GameObject g in input)
            {
                if (!namesDict.ContainsKey(g.name))
                {
                    namesDict[g.name] = new List<GameObject>() { g };
                }
                else
                {
                    namesDict[g.name].Add(g);
                }
            }

            // Merge groups (and their children)
            foreach (var group in namesDict)
            {
                if (group.Value.Count > 1)
                {
                    var extendedGroup = new List<GameObject>();
                    foreach (var g in group.Value)
                    {
                        if (g != null)
                            extendedGroup.AddRange(g.GetChildren(true, true));
                    }
                    extendedGroup.Merge();
                }
            }

            // Get output gameobjects to display correctly process info
            var output = from g in input where g != null select g;
            return output.ToList();
        }

        private IList<GameObject> MergeByMaterials(IList<GameObject> input)
        {
            var mergeAllAction = new Merge();
            mergeAllAction.type = Merge.MergeMode.MergeAll;
            mergeAllAction.Input = input;
            input = mergeAllAction.run(input);

            var explodeAction = new ExplodeSubmeshesAction();
            input = explodeAction.run(input);

            // Get output gameobjects to display correctly process info
            var output = from g in input where g != null select g;
            return output.ToList();
        }

        private List<GameObject> PostProcessMergeByRegions()
        {
            // We don't support merging for skinned mesh with this function so let's get rid of all input
            DeleteAllInput();

            var output = new List<GameObject>();

            GameObject newRoot = new GameObject("Regions");
            Selection.activeGameObject = newRoot;

            output.Add(newRoot);
            Undo.RegisterCreatedObjectUndo(newRoot, "MergeByRegions");

            // We now need to recreate a new hierarchy
            List<Transform> outputParts = new List<Transform>();

            Dictionary<uint, UnityEngine.Object> entityPixyzToObjectUnity = new Dictionary<uint, UnityEngine.Object>();

            foreach (uint occ in _outputOccurrence.list)
            {
                outputParts.AddRange(Converter.Convert(occ, entityPixyzToObjectUnity).Values);
            }

            Dictionary<int, Transform> regionRoots = new Dictionary<int, Transform>();
            for (int i = 0; i < outputParts.Count; i++)
            {
                if (_outputNames.Length > i && _outputNames[i].StartsWith("Region_"))
                {
                    if (mergeStrategy == MergeStrategy.MergeByMaterials)
                    {
                        // Get region index
                        int.TryParse(Regex.Match(_outputNames[i], @"\d+").Value, out int index);
                        regionRoots.TryGetValue(index, out Transform root);
                        if (root == null)
                        {
                            root = new GameObject("Region_" + index.ToString()).transform;
                            output.Add(root.gameObject);
                            root.parent = newRoot.transform;
                            regionRoots[index] = root;
                        }

                        outputParts[i].transform.parent = root;
                        outputParts[i].gameObject.name = _outputNames[i];
                    }
                    else
                    {
                        outputParts[i].transform.parent = newRoot.transform;
                        outputParts[i].gameObject.name = _outputNames[i];
                    }
                    output.Add(outputParts[i].gameObject);
                }
                else
                {
                    // Should not happen
                    SceneExtensionsEditor.DestroyImmediateSafe(outputParts[i].gameObject);
                    Debug.LogWarning("A GameObject has been deleted.");
                }
            }

            // Move pivot point to centers of newly created GameObjects
            MovePivotAction movePivotAction = new MovePivotAction();
            movePivotAction.target = MovePivotAction.MovePivotOption.ToCenterOfBoundingBox;
            movePivotAction.runOncePerObject = true;
            movePivotAction.run(newRoot.GetChildren(true, true));

            Undo.RegisterFullObjectHierarchyUndo(newRoot, "MergeByRegions");

            return output;
        }
        #endregion

        #region warnings_and_errors
        private bool skinnedMesh = false;
        private bool sameLevel = true;
        private int maxDepth = 0;

        public override void onSelectionChanged(IList<GameObject> selection)
        {
            base.onSelectionChanged(selection);
            skinnedMesh = false;

            foreach (var go in selection)
            {
                Renderer r = go.GetComponent<Renderer>();
                if (r == null)
                    continue;

                if (r is SkinnedMeshRenderer && !skinnedMesh)
                {
                    skinnedMesh = true;
                }
            }

            // Check if all selected objects are at the same level in hierarchy
            int lastLevel = -1;
            foreach (GameObject obj in UnityEditor.Selection.gameObjects)
            {
                // Get object depth
                int level = 0;
                Transform transform = obj.transform;
                while (transform != null)
                {
                    level += 1;
                    transform = transform.parent;
                }

                // Check if level is same as last object (if not first object)
                if (lastLevel != -1 && lastLevel != level)
                {
                    sameLevel = false;
                    break;
                }
                lastLevel = level;
                sameLevel = true;
            }

            // Get max depth to potentially display a warning
            maxDepth = GetMaxDepth(selection);
        }

        private int GetMaxDepth(IList<GameObject> roots)
        {
            int maxDepth = 0;
            foreach (var root in roots)
            {
                int rootMaxDepth = 0;
                GetMaxDepthRecursive(0, root, ref maxDepth);
                if (rootMaxDepth > maxDepth) maxDepth = rootMaxDepth;
            }
            return maxDepth;
        }

        private void GetMaxDepthRecursive(int currentDepth, GameObject g, ref int maxDepth)
        {
            currentDepth++;
            if (currentDepth > maxDepth) maxDepth = currentDepth;
            foreach (var child in g.GetChildren(false, false))
            {
                GetMaxDepthRecursive(currentDepth, child, ref maxDepth);
            }
        }

        public override IList<string> getWarnings()
        {
            var warnings = new List<string>();
            if (type == Merge.MergeMode.MergeHierarchyLevel && sameLevel && hierarchyLevel > maxDepth)
            {
                warnings.Add($"Hierarchy level is higher than tree depth ({maxDepth})");
            }
            return warnings;
        }
        public override IList<string> getErrors()
        {
            var errors = new List<string>();
            if (type == Merge.MergeMode.MergeHierarchyLevel && !sameLevel)
            {
                errors.Add("Selected GameObjects are not at the same level in Hierarchy.");
            }
            if (type == Merge.MergeMode.MergeHierarchyLevel && hierarchyLevel < 1)
            {
                errors.Add("Hierarchy level is too low! (must be higher than 1)");
            }
            if (mergeBySizeOfRegions() && sizeOfRegions <= 0)
            {
                errors.Add("Size of regions is too low! (must be higher than 0)");
            }
            if (mergeByNumberOfRegions() && numberOfRegions <= 0)
            {
                errors.Add("Size of regions is too low! (must be higher than 0)");
            }
            if (skinnedMesh)
            {
                errors.Add("Selection contains Skinned Mesh Renderer.\nMerge is not possible with SkinnedMesh.");
            }
            return errors;
        }
        #endregion
}

public static class SceneExtensions
{

    public static GameObject MergeAndCreateNewMaterials(this IList<GameObject> input)
    {
        Regex regex = new Regex("_LOD[1-9]$");
        GameObject highestCommonAncestor = input.GetHighestAncestor();
        MergingContainer meshTransfer = new MergingContainer();

        for (int i = 0; i < input.Count; i++)
        {
            if (input[i] == null) continue;

            if (highestCommonAncestor == null) continue;

            // When merging an object containing LODs, get rid of all LODs except of LOD0
            if (!regex.IsMatch(input[i].name))
            { // Don't merge LODs lower than 0
                meshTransfer.addGameObject(input[i], highestCommonAncestor.transform);
            }

            if (input[i] == highestCommonAncestor)
                continue;

            foreach (Transform child in input[i].transform)
            {
                if (input[i].transform.parent != null)
                {
                    child.SetParentSafe(input[i].transform.parent, true);
                }
                else
                {
                    child.SetParentSafe(null, true);
                }
            }
        }

        if (meshTransfer.vertexCount > 0)
        {
            highestCommonAncestor.GetOrAddComponent<MeshFilter>().sharedMesh = meshTransfer.getMesh();
            highestCommonAncestor.GetOrAddComponent<MeshRenderer>().sharedMaterials = meshTransfer.sharedMaterials;
        }

        for (int i = 0; i < input.Count; i++)
        {
            if (input[i] != highestCommonAncestor)
            {
                input[i].DestroyImmediateSafe();
            }
        }
        return highestCommonAncestor;
    }

}
*/
