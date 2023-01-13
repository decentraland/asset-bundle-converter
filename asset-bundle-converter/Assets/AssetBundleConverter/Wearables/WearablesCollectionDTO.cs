using System;
using System.Collections.Generic;

[Serializable]
public class WearablesCollectionDTO
{
    [Serializable]
    public class Wearable
    {
        [Serializable]
        public class Data
        {
            [Serializable]
            public class Representation
            {
                [Serializable]
                public class Content
                {
                    public string key;
                    public string url;
                }

                public Content[] contents;
            }

            public Representation[] representations;
        }

        public string id;
        public string thumbnail;
        public Data data;
    }

    /// <summary>
    /// Default limit is 500 so pagination is not really used,
    /// Start using it if it becomes a problem
    /// </summary>
    [Serializable]
    public class PaginationData
    {
        public int limit;
        public string next = null;
    }

    public List<Wearable> wearables;
    public PaginationData pagination;
}
