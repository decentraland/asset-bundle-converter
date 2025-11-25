using System;

namespace DCL
{
    public static class ContentServerUtils
    {
        private const string DEFAULT_ENDPOINT_CONTENTS = "/content/contents/";
        private const string DEFAULT_ENDPOINT_ENTITIES = "/content/entities/active";
        private const string DEFAULT_ENDPOINT_LAMBDAS = "/lambdas/";

        [Serializable]
        public class PointerData
        {
            public int x;
            public int y;
        }

        [Serializable]
        public class MappingPair
        {
            public string file;
            public string hash;
        }

        [Serializable]
        public class EntityMappingsDTO
        {
            public string id;
            public string type;
            public string[] pointers;
            public long timestamp;
            public MappingPair[] content;

            // not every entity is an emote but this does not fail for now, if we need to parse other entities we need to refactor this a bit
            public EmoteMetadataDTO metadata;
        }

        [Serializable]
        public struct Representation
        {
            public string[] bodyShapes;
            public string mainFile;
            public string[] contents;
            public string[] overrideHides;
            public string[] overrideReplaces;
        }

        [Serializable]
        public abstract class DataBase
        {
            public Representation[] representations;
            public string category;
            public string[] tags;
            public string[] replaces;
            public string[] hides;
            public string[] removesDefaultHiding;
        }

        [Serializable]
        public struct I18n
        {
            public string code;
            public string text;
        }

        [Serializable]
        public abstract class MetadataBase
        {
            public abstract DataBase AbstractData { get; }

            //urn
            public string id;
            public string name;

            public I18n[] i18n;
            public string thumbnail;

            public string rarity;
            public string description;
        }

        [Serializable]
        public class EmoteMetadataDTO : MetadataBase
        {
            public bool IsSocialEmote => emoteDataADR74 is { outcomes: { Length: > 0 } };

            public Data emoteDataADR74;

            public override DataBase AbstractData => emoteDataADR74!;

            [Serializable]
            public class Data : DataBase
            {
                public bool loop;
                public bool randomizeOutcomes;
                public EmoteStartClipsDTO? startAnimation;
                public EmoteOutcomeDTO[]? outcomes;
            }

            [Serializable]
            public class EmoteOutcomeDTO
            {
                public string title;
                public bool loop;
                public EmoteOutcomeClipsDTO? clips;
                public string? audio;
            }

            [Serializable]
            public class EmoteAnimationDTO
            {
                public string animation;
            }

            [Serializable]
            public class EmoteOutcomeClipsDTO
            {
                public EmoteAnimationDTO? Armature;
                public EmoteAnimationDTO? Armature_Other;
                public EmoteAnimationDTO? Armature_Prop;
            }

            [Serializable]
            public class EmoteStartClipsDTO
            {
                public bool loop;
                public EmoteAnimationDTO? Armature;
                public EmoteAnimationDTO? Armature_Prop;
                public string? audio;
            }
        }

        public enum ApiTLD
        {
            NONE,
            TODAY,
            ZONE,
            ORG,
            WORLDS,
        }

        public static string GetTldString(ApiTLD tld)
        {
            switch (tld)
            {
                case ApiTLD.NONE:
                    break;
                case ApiTLD.TODAY:
                    return "today";
                case ApiTLD.ZONE:
                    return "zone";
                case ApiTLD.ORG:
                    return "org";
            }

            return "org";
        }

        public static string customBaseUrl = "";

        private static string GetBaseUrl(ApiTLD tld)
        {
            if (tld == ApiTLD.WORLDS)
                return "https://worlds-content-server.decentraland.org";

            if (tld != ApiTLD.NONE)
                return $"https://peer.decentraland.{GetTldString(tld)}";

            return customBaseUrl;
        }

        public static string GetLambdasUrl(this ApiTLD env) =>
            $"{GetBaseUrl(env)}{DEFAULT_ENDPOINT_LAMBDAS}";
    }
}
