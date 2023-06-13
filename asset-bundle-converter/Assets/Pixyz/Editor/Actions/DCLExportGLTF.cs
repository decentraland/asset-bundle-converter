using System.Linq;
using GLTFast;
using UnityEngine;
using GLTFast.Export;
using System.Threading.Tasks;
using UnityEditor.PixyzPlugin4Unity.Toolbox;

public class DCLExportGLTF : PixyzFunction {


    public int lodLevel = 1;
    public string path;

    public override int id { get { return 598339869;} }
    public override string menuPathRuleEngine { get { return "DCL/Export GLTF";} }
    public override string menuPathToolbox { get { return null;} }
    public override string tooltip { get { return "Export GLTF";} }

    public Task<bool> exportTask;


    protected override void postProcess()
    {
        var exportSettings = new ExportSettings {
            Format = GltfFormat.Binary,
            FileConflictResolution = FileConflictResolution.Abort,
            // Export everything except cameras or animation
            ComponentMask = ~(ComponentType.Camera | ComponentType.Animation),
            // Boost light intensities
            LightIntensityFactor = 100f,
        };


        var export = new GameObjectExport(exportSettings);
        // Add a scene
        export.AddScene(_input.ToArray());
        string pathToSave = $"{Application.dataPath}/_Downloaded/{_input[0].gameObject.name}_lod{lodLevel}/{_input[0].gameObject.name}_lod{lodLevel}.glb";
        //string pathToSave = (path ?? Application.dataPath) + $"/_Downloaded/{_input[0].gameObject.name}_lod{lodLevel}/{_input[0].gameObject.name}_lod{lodLevel}.glb";
        // Async glTF export
        exportTask = export.SaveToFileAndDispose(pathToSave);
        DeleteAllInput();
    }


}
