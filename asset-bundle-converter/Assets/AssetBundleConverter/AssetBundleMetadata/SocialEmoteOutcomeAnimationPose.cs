
using System;
using UnityEngine;

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
