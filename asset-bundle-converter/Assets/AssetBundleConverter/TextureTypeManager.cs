using UnityEngine;
using System.Collections.Generic;

[System.Flags]
public enum TextureType
{
    None = 0,
    MainTex = 1 << 0,
    BaseMap = 1 << 1,
    BumpMap = 1 << 2,
    MetallicGlossMap = 1 << 3,
    ParallaxMap = 1 << 4,
    OcclusionMap = 1 << 5,
    EmissionMap = 1 << 6,
    SpecGlossMap = 1 << 7
}

public struct TextureInfo
{
    public string Name;
    public TextureType Types;

    public TextureInfo(string name)
    {
        Name = name;
        Types = TextureType.None;
    }
}

public static class TextureInfoExtensions
{
    public static TextureType GetTextureTypeFromString(string input)
    {
        switch (input)
        {
            case "_MainTex" :
                return TextureType.MainTex;
            case "_BaseMap" :
                return TextureType.BaseMap;
            case "_BumpMap" :
                return TextureType.BumpMap;
            case "_MetallicGlossMap" :
                return TextureType.MetallicGlossMap;
            case "_ParallaxMap" :
                return TextureType.ParallaxMap;
            case "_OcclusionMap" :
                return TextureType.OcclusionMap;
            case "_EmissionMap" :
                return TextureType.EmissionMap;
            case "_SpecGlossMap" :
                return TextureType.SpecGlossMap;
            default :
                return TextureType.None;
        }
    }



    public static TextureInfo AddType(this TextureInfo info, TextureType type)
    {
        info.Types |= type;
        return info;
    }

    public static TextureInfo RemoveType(this TextureInfo info, TextureType type)
    {
        info.Types &= ~type;
        return info;
    }

    public static bool HasType(this TextureInfo info, TextureType type)
    {
        return (info.Types & type) != 0;
    }

    public static bool HasAnyType(this TextureInfo info, TextureType types)
    {
        return (info.Types & types) != 0;
    }

    public static bool HasAllTypes(this TextureInfo info, TextureType types)
    {
        return (info.Types & types) == types;
    }

    public static string GetTypesString(this TextureInfo info)
    {
        return $"{info.Name}: {info.Types}";
    }
}

public class TextureTypeManager : MonoBehaviour
{
    private Dictionary<string, TextureInfo> textureInfos = new Dictionary<string, TextureInfo>();

    public void AddTextureType(string textureName, TextureType type)
    {
        if (!textureInfos.TryGetValue(textureName, out TextureInfo info))
        {
            info = new TextureInfo(textureName);
        }
        textureInfos[textureName] = info.AddType(type);
    }

    public TextureInfo GetTextureInfo(string textureName)
    {
        return textureInfos.TryGetValue(textureName, out TextureInfo info) ? info : new TextureInfo(textureName);
    }

    public bool HasTextureType(string textureName, TextureType type)
    {
        return textureInfos.TryGetValue(textureName, out TextureInfo info) && info.HasType(type);
    }
}
