using System.Linq;
using GLTFast;
using UnityEngine;
using GLTFast.Export;
using System;
using System.Collections;
using System.Threading.Tasks;
using UnityEditor.PixyzPlugin4Unity.Toolbox;
using UnityEngine.PixyzCommons.Utilities;

public class DCLExportGLTF : PixyzFunction {


    public int lodLevel = 1;

    public override int id { get { return 598339869;} }
    public override string menuPathRuleEngine { get { return "DCL/Export GLTF";} }
    public override string menuPathToolbox { get { return null;} }
    public override string tooltip { get { return "Export GLTF";} }

    public event Action<bool> OnExportCompleted;
    protected override void postProcess()
    {
        DoExport();
    }

    private async void DoExport()
    {
        var exportSettings = new ExportSettings {
            Format = GltfFormat.Binary,
            FileConflictResolution = FileConflictResolution.Overwrite,
        };
        var export = new GameObjectExport(exportSettings);
        // Add a scene
        export.AddScene(_input.ToArray());
        string pathToSave = $"{Application.dataPath}/_Downloaded/{_input[0].gameObject.name}_lod{lodLevel}/{_input[0].gameObject.name}_lod{lodLevel}.glb";

        bool exportSuccesfull = await export.SaveToFileAndDispose(pathToSave);

        DeleteAllInput();
        OnExportCompleted?.Invoke(exportSuccesfull);
    }

}
