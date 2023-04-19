using DCL;
using System;
using System.Collections.Generic;
using System.Linq;
using System.Net.Http;
using UnityEngine;
using UnityEngine.Networking;
using DownloadHandler = UnityEngine.Networking.DownloadHandler;

namespace AssetBundleConverter.Wearables
{
    public static class WearablesClient
    {
        private const string COLLECTION_PATH = "collections/wearables?collectionId=";

        public static IReadOnlyList<ContentServerUtils.MappingPair> GetCollectionMappings(string collectionId, ContentServerUtils.ApiTLD apiTld,
            IWebRequest webRequest)
        {
            var url = $"{apiTld.GetLambdasUrl()}{COLLECTION_PATH}{collectionId}";
            Debug.Log(url);

            DownloadHandler downloadHandler;

            try { downloadHandler = webRequest.Get(url); }
            catch (HttpRequestException e)
            {
                throw new Exception($"Wearables Collection {collectionId} can't be fetched", e);
            }

            var wearablesDTO = JsonUtility.FromJson<WearablesCollectionDTO>(downloadHandler.text);
            return GetMappingPairs(wearablesDTO);
        }

        private static List<ContentServerUtils.MappingPair> GetMappingPairs(WearablesCollectionDTO wearables)
        {
            var contentMappingPairs = new List<ContentServerUtils.MappingPair>();

            if (wearables.wearables == null || wearables.wearables.Count == 0)
                return contentMappingPairs;

            foreach (var wearableData in wearables.wearables)
            {
                foreach (var wearableDataRepresentation in wearableData.data.representations)
                {
                    foreach (var content in wearableDataRepresentation.contents)
                    {
                        if (string.IsNullOrEmpty(content.url))
                        {
                            Debug.LogWarning($"WearablesAPIData - Couldn't get hash from mappings for asset '{content.key}', it's content.url is null!");
                            continue;
                        }

                        contentMappingPairs.Add(new ContentServerUtils.MappingPair
                        {
                            file = content.key,
                            hash = content.url.Substring(content.url.LastIndexOf("/") + 1)
                        });
                    }
                }
            }

            return contentMappingPairs;
        }
    }
}
