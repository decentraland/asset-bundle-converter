using System;
using System.Threading.Tasks;
using UnityEditor;
using UnityEditor.PixyzPlugin4Unity.RuleEngine;
using UnityEngine;

public class LODGenerator
{
    private int currentRuleSet = 0;
    private RuleSet[] rulesSet;
    private DCLExportGLTF dclExportGltf;
    private GameObject og;

    // I have to create a task because I cant wait for the GLTF exporter to finish in a
    // PiXYZ postprocess rule method. Therefore, I manually control the CompletionSource.
    private TaskCompletionSource<bool> tcs;

    public Task Generate(GameObject originalGameobject)
    {
        tcs = new TaskCompletionSource<bool>();
        this.og = originalGameobject;
        rulesSet = new RuleSet[]
        {
            AssetDatabase.LoadAssetAtPath<RuleSet>("Assets/Pixyz/RuleSets/CombineAndDecimate_50.asset"),
            AssetDatabase.LoadAssetAtPath<RuleSet>("Assets/Pixyz/RuleSets/CombineAndDecimate_10.asset")
        };

        currentRuleSet = 0;
        if (rulesSet.Length > 1)
            SetupRuleSet(rulesSet[currentRuleSet]);
        return tcs.Task;
    }

    private void SetupRuleSet(RuleSet ruleSet)
    {
        GameObject gameobjectToLod = GameObject.Instantiate(og);
        gameobjectToLod.name = og.name;

        foreach (RuleBlock ruleBlock in ruleSet.getRule(0).Blocks)
        {
            if (ruleBlock.action is GetGameObject getGameObjectAction)
                getGameObjectAction.gameobject = gameobjectToLod;
            if (ruleBlock.action is DCLExportGLTF exportGltfAction)
            {
                dclExportGltf = exportGltfAction;
                exportGltfAction.lodLevel = currentRuleSet+1;
                exportGltfAction.OnExportCompleted += ExportComplete;
            }
            if (ruleBlock.action is DCLSetupMaterialsAndTextures setupExportAction)
                setupExportAction.lodLevel = currentRuleSet+1;
        }

        try
        {
            ruleSet.run();
        }
        catch (Exception e)
        {
            GameObject.DestroyImmediate(gameobjectToLod);
            tcs.SetException(new Exception($"[Lod Generator] LOD RuleSet failed for {ruleSet.name}"));
        }
    }


    private void ExportComplete(bool exportSuccesfull)
    {
        dclExportGltf.OnExportCompleted -= ExportComplete;

        if (!exportSuccesfull)
            tcs.SetException(new Exception("[Lod Generator] GLTF export failed"));

        currentRuleSet++;
        if (currentRuleSet < rulesSet.Length)
            SetupRuleSet(rulesSet[currentRuleSet]);
        else
            tcs.SetResult(true);
    }

}
