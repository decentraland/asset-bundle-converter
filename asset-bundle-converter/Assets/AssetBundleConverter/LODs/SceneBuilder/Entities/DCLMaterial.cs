// unset:none
using AssetBundleConverter.LODs.JsonParsing;
using System;
using System.Collections.Generic;
using Unity.Plastic.Newtonsoft.Json;
using UnityEditor;
using UnityEngine;

namespace AssetBundleConverter.LODs
{
    [JsonConverter(typeof(MaterialDataConverter))]
    [Serializable]
    public abstract class DCLMaterial
    {
        public TextureData texture;
        protected virtual Color GetColor() => Color.white;
        protected abstract Shader GetShader();

        public Material GetMaterial(Dictionary<string, string> contentTable)
        {
            Material material = new Material(GetShader());
            material.color = GetColor();
            if (texture?.tex?.src != null)
            {
                if (contentTable.TryGetValue(texture.tex.src, out string texturePath))
                {
                    Texture2D textureA = AssetDatabase.LoadAssetAtPath<Texture2D>(texturePath);
                    material.mainTexture = textureA;
                }
            }

            return material;
        }

    }

    [Serializable]
    public class UnlitMaterial : DCLMaterial
    {
        private static readonly Shader CACHED_SHADER = Shader.Find("Universal Render Pipeline/Unlit");
        protected override Shader GetShader() =>
            CACHED_SHADER;
    }

    [Serializable]
    public class PBRMaterial : DCLMaterial
    {
        private static readonly Shader CACHED_SHADER = Shader.Find("Universal Render Pipeline/Lit");
        public AlbedoColor albedoColor = new ();

        protected override Color GetColor() =>
            new (albedoColor.r, albedoColor.g, albedoColor.b, albedoColor.a);

        protected override Shader GetShader() =>
            CACHED_SHADER;
    }

    [Serializable]
    public class TextureData
    {
        public Texture tex;
    }

    [JsonConverter(typeof(TextureDataConverter))]
    [Serializable]
    public class Texture
    {
        public string src;
    }

    [Serializable]
    public class AlbedoColor
    {
        public int r = 1;
        public int g = 1;
        public int b = 1;
        public int a = 1;
    }
}
