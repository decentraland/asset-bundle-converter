namespace DCL
{
    public static class ContentServerUtils
    {
        private const string DEFAULT_ENDPOINT_CONTENTS = "/content/contents/";
        private const string DEFAULT_ENDPOINT_ENTITIES = "/content/entities/active";

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
        public static string customEndpoint = "";

        private static string GetBaseUrl(ApiTLD tld)
        {
            if (tld != ApiTLD.NONE)
                return $"https://peer.decentraland.{GetTldString(tld)}";

            return customBaseUrl;
        }

        private static string GetPointersEndpoint() => DEFAULT_ENDPOINT_ENTITIES;

        public static string GetContentsUrl(ApiTLD env)
        {
            string baseUrl = GetBaseUrl(env);
            var endpoint = !string.IsNullOrEmpty(customEndpoint) ? customEndpoint : DEFAULT_ENDPOINT_CONTENTS;

            return $"{baseUrl}{endpoint}";
        }

        public static string GetEntitiesUrl(ApiTLD env)
        {
            string baseUrl = GetBaseUrl(env);
            var endpoint = GetPointersEndpoint();

            return $"{baseUrl}{endpoint}";
        }
    }
}