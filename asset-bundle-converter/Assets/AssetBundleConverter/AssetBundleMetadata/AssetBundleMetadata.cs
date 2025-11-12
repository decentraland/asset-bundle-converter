
using System;
using UnityEngine;

[System.Serializable]
public class AssetBundleMetadata
{
    [Serializable]
    public struct SocialEmoteOutcomeAnimationPose
    {
        public Vector3 Position;
        public Quaternion Rotation;

        public SocialEmoteOutcomeAnimationPose(Vector3 position, Quaternion rotation)
        {
            Position = position;
            Rotation = rotation;
        }
    }

    public long timestamp = -1;
    public string version = "1.0";
    public string[] dependencies;
    public string mainAsset;
    public SocialEmoteOutcomeAnimationPose[] socialEmoteOutcomeAnimationStartPoses;
    // TODO: Why there are 2 elements per outcome? sex?
}
