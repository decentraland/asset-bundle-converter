namespace DCL
{
    public static class ContentServerUtils
    {
        private const string DEFAULT_ENDPOINT_CONTENTS = "/content/contents/";
        private const string DEFAULT_ENDPOINT_ENTITIES = "/content/entities/active";
        private const string DEFAULT_ENDPOINT_LAMBDAS = "/lambdas/";

        [System.Serializable]
        public class PointerData
        {
            public int x;
            public int y;
        }

        [System.Serializable]
        public class MappingPair
        {
            public string file;
            public string hash;
        }

        [System.Serializable]
        public class EntityMappingsDTO
        {
            public string type;
            public string[] pointers;
            public long timestamp;
            public MappingPair[] content;
            public object metadata;
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
