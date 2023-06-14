using System;
using System.Collections;
using System.Threading.Tasks;
using UnityEditor;
using UnityEditor.PixyzPlugin4Unity.RuleEngine;
using UnityEngine;
using UnityEngine.PixyzCommons.Utilities;

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
            {
                getGameObjectAction.gameobject = gameobjectToLod;
            }
            if (ruleBlock.action is DCLExportGLTF exportGltfAction)
            {
                dclExportGltf = exportGltfAction;
                exportGltfAction.lodLevel = currentRuleSet+1;
            }
            if (ruleBlock.action is DCLSetupMaterialsAndTextures setupExportAction)
            {
                setupExportAction.lodLevel = currentRuleSet+1;
            }
        }
        ruleSet.OnCompleted += () =>
        {
            ruleSet.OnCompleted = null;
            // If the export task, from the last rule, is null; it means that it completed with never getting there.
            // So the rule set has failed
            if (dclExportGltf.exportTask == null)
                tcs.SetException(new Exception($"[Lod Generator] LOD RuleSet failed for {ruleSet.name}"));
            else
                // We need the export task to finish, and I cant make the RuleSet async without modifying Action.cs.
                // Therefore, we need to wait for the export task to finish.
                dclExportGltf.exportTask.ContinueWith(OnExportComplete);
        };
        ruleSet.run();
    }

    private void OnExportComplete(Task<bool> result)
    {
        if (result.Result)
            Dispatcher.StartCoroutine(AnalyzeResult());
        else
            tcs.SetException(new Exception("[Lod Generator] GLTF export failed"));
    }

    private IEnumerator AnalyzeResult()
    {
        currentRuleSet++;
        if (currentRuleSet < rulesSet.Length)
        {
            // We have to wait for the main thread to run get the unity gameobject
            yield return Dispatcher.GoMainThread();
            SetupRuleSet(rulesSet[currentRuleSet]);
        }
        else
            tcs.SetResult(true);
    }
}
