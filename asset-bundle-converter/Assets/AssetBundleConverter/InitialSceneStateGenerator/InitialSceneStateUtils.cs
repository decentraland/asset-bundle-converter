using Newtonsoft.Json.Linq;
using System.Collections.Generic;
using UnityEngine;

namespace AssetBundleConverter.InitialSceneStateGenerator
{
    public class SceneComponent
    {
        public int entityId;
        public int componentId;
        public string componentName;
        public object data; // Can be TransformData, MaterialComponentData, etc.

        public bool TryGetData<T>(out T result) where T : class
        {
            if (data is JObject jObject)
            {
                try
                {
                    result = jObject.ToObject<T>();
                    return result != null;
                }
                catch
                {
                    result = null;
                    return false;
                }
            }

            result = null;
            return false;
        }
    }

    public class TransformData
    {
        public Vector3 position;
        public Quaternion rotation;
        public Vector3 scale;
        public int parent;
    }

    public class MeshRendererData
    {
        public string src;
        public int invisibleMeshesCollisionMask;
    }

    // Material Component
    public class MaterialComponentData
    {
        public MaterialWrapper material;

        // Helper methods to extract texture sources
        public List<string> GetAllTextureSources()
        {
            var sources = new List<string>();

            if (material?.pbr != null)
            {
                AddTextureSource(sources, material.pbr.texture);
                AddTextureSource(sources, material.pbr.emissiveTexture);
            }

            if (material?.unlit != null)
            {
                AddTextureSource(sources, material.unlit.texture);
                AddTextureSource(sources, material.unlit.alphaTexture);
            }

            return sources;
        }

        public string GetPrimaryTextureSrc()
        {
            // Try PBR first
            if (material?.pbr?.texture != null)
            {
                return GetTextureSrc(material.pbr.texture);
            }

            // Try unlit
            if (material?.unlit?.texture != null)
            {
                return GetTextureSrc(material.unlit.texture);
            }

            return null;
        }

        private void AddTextureSource(List<string> sources, TextureWrapper wrapper)
        {
            string src = GetTextureSrc(wrapper);
            if (!string.IsNullOrEmpty(src))
            {
                sources.Add(src);
            }
        }

        private string GetTextureSrc(TextureWrapper wrapper)
        {
            return wrapper?.tex?.texture?.src;
        }
    }

    public class MaterialWrapper
    {
        public PbrMaterial pbr;
        public UnlitMaterial unlit;
    }

    public class PbrMaterial
    {
        public TextureWrapper texture;
        public TextureWrapper emissiveTexture;
        public ColorData emissiveColor;
        public float metallic;
        public float roughness;
        public float specularIntensity;
        public float emissiveIntensity;
    }

    public class UnlitMaterial
    {
        public TextureWrapper texture;
        public TextureWrapper alphaTexture;
        public ColorData diffuseColor;
    }

    public class TextureWrapper
    {
        public TextureCase tex;
    }

    public class TextureCase
    {
        public TextureData texture;
        public AvatarTextureData avatarTexture;
    }

    public class TextureData
    {
        public string src;
        public int wrapMode;
        public int filterMode;
    }

    public class AvatarTextureData
    {
        public string userId;
    }

    public class ColorData
    {
        public float r;
        public float g;
        public float b;
        public float a;
    }

    public class VisibilityData
    {
        public bool visible;
    }
}
