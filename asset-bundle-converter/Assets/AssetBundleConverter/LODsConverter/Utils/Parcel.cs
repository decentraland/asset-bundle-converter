using System;
using System.Collections.Generic;
using Unity.Plastic.Newtonsoft.Json;
using UnityEngine;

namespace AssetBundleConverter.LODsConverter.Utils
{
    [Serializable]
            public class ParcelResponse
            {
                public List<Parcel> results;
            }
    
            [Serializable]
            public class Parcel
            {
                public ParcelMetadata metadata;
    
                public Vector2Int GetDecodedBaseParcel()
                {
                    var decodedPointer = ParsePointer(metadata.scene.baseParcel);
                    return decodedPointer;
                }
    
                private Vector2Int ParsePointer(string pointer)
                {
                    string[] coords = pointer.Split(',');
                    int x = int.Parse(coords[0]);
                    int y = int.Parse(coords[1]);
                    Vector2Int decodedPointer = new Vector2Int(x, y);
                    return decodedPointer;
                }
    
                public List<Vector2Int> GetDecodedParcels()
                {
                    List<Vector2Int> decodedParcels = new List<Vector2Int>();
                    foreach (string pointer in metadata.scene.parcels)
                    {
                        decodedParcels.Add(ParsePointer(pointer));
                    }
                    return decodedParcels;
                }
            }
            
            [Serializable]
            public class ParcelMetadata
            {
                public SceneDescription scene;
            }
            
            [Serializable]
            public class SceneDescription
            {
                public string[] parcels;
                [JsonProperty("base")]
                public string baseParcel;
            }
}