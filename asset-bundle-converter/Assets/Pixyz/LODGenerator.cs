using DCL;
using System;
using System.Threading.Tasks;
using UnityEditor;
using UnityEditor.PixyzPlugin4Unity.RuleEngine;
using UnityEngine;
using UnityEngine.PixyzPlugin4Unity.Utilities;

public class LODGenerator
{
    private int currentRuleSet = 0;
    private RuleSet[] rulesSet;
    private DCLExportGLTF dclExportGltf;
    private GameObject og;
    private IABLogger logger;

    // I have to create a task because I cant wait for the GLTF exporter to finish in a
    // PiXYZ postprocess rule method. Therefore, I manually control the CompletionSource.
    private TaskCompletionSource<bool> tcs;

    public Task<bool> Generate(GameObject originalGameobject, IABLogger logger)
    {
        tcs = new TaskCompletionSource<bool>();
        this.og = originalGameobject;
        this.logger = logger;
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

        // This is a hack to capture if there was an exception thrown inside the PiXYZ plugin.
        // Since we cant modify tha code and can not wrap it inside a try/catch (because its already catch in the plugin)
        // this is the only way I found to catch an exception.
        ruleSet.progressed += RuleSetProgressed();
        ruleSet.run();
    }

    private ProgressHandler RuleSetProgressed()
    {
        return (float progress, string message) =>
        {
            if (progress.Equals(1f) && message.Equals("Failure!"))
            {
                tcs.SetResult(false);
                dclExportGltf.OnExportCompleted -= ExportComplete;
            }
        };
    }

    private void ExportComplete(bool exportSuccesfull)
    {
        dclExportGltf.OnExportCompleted -= ExportComplete;

        if (!exportSuccesfull)
        {
            logger.Exception($"[Lod Generator] GLTF export failed");
            tcs.SetResult(false);
        }

        currentRuleSet++;
        if (currentRuleSet < rulesSet.Length)
            SetupRuleSet(rulesSet[currentRuleSet]);
        else
            tcs.SetResult(true);
    }

}
