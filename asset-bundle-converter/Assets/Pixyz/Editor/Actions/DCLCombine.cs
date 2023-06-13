using System.Collections.Generic;
using UnityEditor.PixyzPlugin4Unity.Toolbox;
using UnityEngine;
using UnityEditor.PixyzPlugin4Unity.UI;
using UnityEngine.PixyzCommons.Conversion;
using UnityEngine.PixyzPlugin4Unity.Licensing;


public class DCLCombine : PixyzFunction
    {
        public override int id => 494293734;
        public override int order => 9;
        public override string menuPathRuleEngine => "DCL/Combine";
        public override string menuPathToolbox => null;
        public override string tooltip => "DCL Combine";

		protected override MaterialSyncType SyncMaterials => MaterialSyncType.SyncFull;
		protected override HierarchyLoadType HierarchyMode => HierarchyLoadType.New;

		[UserParameter(tooltip: ToolboxTooltips.combineMapResolution)]
        public MapDimensions mapsResolution = MapDimensions._1024;

        [UserParameter(displayName: "Recreate UV", tooltip: ToolboxTooltips.combineUVGen)]
        public bool forceUVGeneration = false;
        private bool isCustom() { return mapsResolution == MapDimensions.Custom; }

        [UserParameter("isCustom", tooltip:"Output maps resolution")]
        public int resolution = 1024;

        
        private bool skinnedMesh = false;

        private uint _newOccurrence = 0;

        protected override void process()
        {
            try
            {
                uint scene = Plugin4UnityProduct.API.Scene.GetRoot();
                Pixyz.Scene.Native.OccurrenceList occurrenceList = new Pixyz.Scene.Native.OccurrenceList(new uint[] { scene });

                Plugin4UnityProduct.API.Core.PushAnalytic("Combine", "");
                UpdateProgressBar(0.25f);

                //WeldVertices
                Pixyz.Polygonal.Native.TopologyCategoryMask topologyMask = new Pixyz.Polygonal.Native.TopologyCategoryMask()
                {
                    dimension = Pixyz.Polygonal.Native.TopologyDimensionMask.FACE,
                    connectivity = Pixyz.Polygonal.Native.TopologyConnectivityMask.BOUNDARY_NONMANIFOLD
                };
                Plugin4UnityProduct.API.Algo.MergeVertices(occurrenceList, 0.0000001, topologyMask);
                UpdateProgressBar(0.43f);

                //CombineMeshes
                resolution = mapsResolution == MapDimensions.Custom ? resolution : (int)mapsResolution;
                var bakeOptions = new Pixyz.Algo.Native.BakeOption
                {
                    bakingMethod = Pixyz.Algo.Native.BakingMethod.RayOnly,
                    resolution = resolution,
                    padding = 2,
                    textures = new Pixyz.Algo.Native.BakeMaps()
                    {
                        ambientOcclusion = true,
                        diffuse = true,
                        metallic = true,
                        normal = true,
                        opacity = true,
                        roughness = true,
                        emissive = true
                    }
                };
                _newOccurrence = Plugin4UnityProduct.API.Algo.CombineMeshes(occurrenceList, bakeOptions, forceUVGeneration);
                Plugin4UnityProduct.API.Scene.TransferMaterialsOnPatches(_newOccurrence);
                Plugin4UnityProduct.API.Scene.ResetTransform(scene, true, true, false);

                UpdateProgressBar(1f);
            }
            catch (System.Exception e)
            {
                Debug.LogError($"[Error] {e.Message} /n {e.StackTrace}");
            }
        }

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
        }

        protected override void postProcess()
        {
            base.postProcess();
            Dictionary<uint, Transform> transforms = Converter.Convert(_newOccurrence);
            GameObject go = transforms[_newOccurrence].gameObject;
            go.name = _input[0].gameObject.name;

            _output = new List<GameObject>() { go };
            DeleteAllInput();
        }

        public override IList<string> getErrors()
        {
            var errors = new List<string>();
            if (isCustom())
            {
                if (resolution < 64)
                {
                    errors.Add("Maps resolution is too low ! (must be between 64 and 8192)");
                }
                else if (resolution > 8192)
                {
                    errors.Add("Maps resolution is too high ! (must be between 64 and 8192)");
                }
            }
            if (skinnedMesh)
            {
                errors.Add("Selection contains Skinned Mesh Renderer.\nCombine is not possible with SkinnedMesh.");
            }
            return errors.ToArray();
        }

        public override IList<string> getWarnings()
        {
            var warnings = new List<string>();
            if (UnityEngine.Rendering.GraphicsSettings.renderPipelineAsset != null)
            {
                warnings.Add("Baking maps is only compatible with built-in render pipeline");
            }
            return warnings.ToArray();
        }
    }

