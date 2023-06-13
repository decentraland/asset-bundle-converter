using System;
using System.Collections;
using System.Collections.Generic;
using System.Threading.Tasks;
using UnityEditor;
using UnityEditor.PixyzPlugin4Unity.RuleEngine;
using UnityEngine;

public class LODGenerator
{
    private int currentRuleSet = 0;
    private RuleSet[] rulesSet;
    private TaskCompletionSource<bool> tcs;

    private string persistentPath;
    private DCLExportGLTF dclExportGltf;
    private DCLSetupExport dclSetupExportGltf;
    private GameObject og;
    private int exportComplete;


    public Task Generate(GameObject originalGameobject, string persistingPath)
    {
        this.persistentPath = persistingPath;
        tcs = new TaskCompletionSource<bool>();
        this.og = originalGameobject;
        rulesSet = new RuleSet[]
        {
            AssetDatabase.LoadAssetAtPath<RuleSet>("Assets/Pixyz/RuleSets/CombineAndDecimate_50.asset"),
            AssetDatabase.LoadAssetAtPath<RuleSet>("Assets/Pixyz/RuleSets/CombineAndDecimate_10.asset")
        };

        currentRuleSet = 0;
        exportComplete = 0;
        if (rulesSet.Length > 1)
            RunRuleSet(rulesSet[currentRuleSet]);
        return tcs.Task;
    }

    private void RunRuleSet(RuleSet ruleSet)
    {
        GameObject gameobjectToLod = GameObject.Instantiate(og);
        gameobjectToLod.name = og.name;

        foreach (RuleBlock ruleBlock in ruleSet.getRule(0).Blocks)
        {
            if (ruleBlock.action is GetGameObject getGameObjectAction)
            {
                getGameObjectAction.gameobject = gameobjectToLod;
            }
            if (ruleBlock.action is DCLExportGLTF exportGLTFAction)
            {
                dclExportGltf = exportGLTFAction;
                exportGLTFAction.lodLevel = currentRuleSet+1;
            }
            if (ruleBlock.action is DCLSetupExport setupExportAction)
            {
                dclSetupExportGltf = setupExportAction;
                setupExportAction.lodLevel = currentRuleSet+1;
            }
        }
        ruleSet.run();
        ruleSet.OnCompleted += () =>
        {
            dclExportGltf.exportTask.ContinueWith(OnExportComplete);
            currentRuleSet++;

            if (currentRuleSet < rulesSet.Length)
                RunRuleSet(rulesSet[currentRuleSet]);
            ruleSet.OnCompleted = null;
        };
    }

    private void OnExportComplete(Task<bool> Obj)
    {
        exportComplete++;
        if(exportComplete.Equals(2))
            tcs.SetResult(true);
    }
}
