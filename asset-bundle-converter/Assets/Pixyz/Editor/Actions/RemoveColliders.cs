using System.Collections.Generic;
using System.Linq;
using UnityEditor;
using UnityEngine;
using UnityEditor.PixyzPlugin4Unity.UI;
using UnityEngine.PixyzCommons.Extensions;

public class RemoveColliders : ActionInOut<IList<GameObject>, IList<GameObject>> {

    public override int id { get { return 784373256;} }
    public override string menuPathRuleEngine { get { return "DCL/Remove Colliders";} }
    public override string menuPathToolbox { get { return null;} }
    public override string tooltip { get { return "Remove DCL Colliders";} }

    public override IList<GameObject> run(IList<GameObject> input)
    {
        if (PrefabUtility.IsPartOfAnyPrefab(input.First()))
            PrefabUtility.UnpackPrefabInstance(input.First(), PrefabUnpackMode.Completely, InteractionMode.AutomatedAction);

        IList<GameObject> newInput = new List<GameObject>();
        foreach (var gameObject in input.GetChildren(true,true))
        {
            if (gameObject.name.Contains("_collider"))
            {
                gameObject.transform.SetParent(null);
                Object.DestroyImmediate(gameObject);
            }
            else
                newInput.Add(gameObject);
        }
        return newInput;
    }
}