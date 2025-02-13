using System.Collections.Generic;
using UnityEngine;

namespace AssetBundleConverter.LODsConverter.Utils
{
    public class SceneCircumscribedPlanesCalculator
    {
        private const float PARCEL_SIZE = 16.0f;
        private const float EXTEND_AMOUNT = 0.05f;
        private const float EXTEND_AMOUNT_FOR_DISABLE = 0.5f;
        private const float MAX_HEIGHT = 200f;

        private static ParcelCorners CalculateCorners(Vector2Int parcelPosition)
        {
            Vector3 min = GetPositionByParcelPosition(parcelPosition);
            return new ParcelCorners(min, min + new Vector3(0, 0, PARCEL_SIZE), min + new Vector3(PARCEL_SIZE, 0, PARCEL_SIZE), min + new Vector3(PARCEL_SIZE, 0, 0));
        }

        private static Vector3 GetPositionByParcelPosition(Vector2Int parcelPosition)
        {
            return new Vector3 (parcelPosition.x * PARCEL_SIZE, 0.0f, parcelPosition.y * PARCEL_SIZE);
        }

        private readonly struct SceneCircumscribedPlanes
        {
            public readonly float MinX;
            public readonly float MaxX;
            public readonly float MinZ;
            public readonly float MaxZ;

            public SceneCircumscribedPlanes(float minX, float maxX, float minZ, float maxZ)
            {
                MinX = minX;
                MaxX = maxX;
                MinZ = minZ;
                MaxZ = maxZ;
            }
        }

        private readonly struct ParcelCorners
        {
            public readonly Vector3 minXZ;
            public readonly Vector3 minXmaxZ;
            public readonly Vector3 maxXZ;
            public readonly Vector3 maxXminZ;

            public ParcelCorners(Vector3 minXZ, Vector3 minXmaxZ, Vector3 maxXZ, Vector3 maxXminZ)
            {
                this.minXZ = minXZ;
                this.minXmaxZ = minXmaxZ;
                this.maxXZ = maxXZ;
                this.maxXminZ = maxXminZ;
            }
        }

        private static Bounds CalculateSceneBoundingBox(Vector4 scenePlane)
        {
            Vector3 center = new Vector3((scenePlane[0] + scenePlane[1]) / 2, 0, (scenePlane[2] + scenePlane[3]) / 2);
            
            //NOTE: I was getting inconsistencies on LOD_1 because weird merging was done underground.
            //SO, by setting MAX_HEIGHT * 2, the height wont be larger than MAX_HEIGHT going up,
            //And we'll go until MAX_HEIGHT underground
            var size = new Vector3(scenePlane[1] - scenePlane[0] + EXTEND_AMOUNT_FOR_DISABLE, MAX_HEIGHT * 2,
                scenePlane[3] - scenePlane[2] + EXTEND_AMOUNT_FOR_DISABLE);
            return new Bounds(center, size);
        }
        
        public static void DisableObjectsOutsideBounds(Parcel parcel, GameObject parent)
        {
            parent.transform.position = GetPositionByParcelPosition(parcel.GetDecodedBaseParcel());
            var sceneBoundingBox = CalculateSceneBoundingBox(CalculateScenePlane(parcel.GetDecodedParcels()));
            foreach (var renderer in parent.GetComponentsInChildren<MeshFilter>()) {
                Bounds meshBounds = renderer.sharedMesh.bounds;
                meshBounds.center = renderer.transform.TransformPoint(meshBounds.center);
                meshBounds.size = renderer.transform.TransformVector(meshBounds.size);
                bool isFullyContained = true;
                Vector3[] meshCorners = new Vector3[]
                {
                    meshBounds.min,
                    new Vector3(meshBounds.max.x, meshBounds.min.y, meshBounds.min.z),
                    new Vector3(meshBounds.min.x, meshBounds.max.y, meshBounds.min.z),
                    new Vector3(meshBounds.min.x, meshBounds.min.y, meshBounds.max.z),
                    new Vector3(meshBounds.max.x, meshBounds.max.y, meshBounds.min.z),
                    new Vector3(meshBounds.min.x, meshBounds.max.y, meshBounds.max.z),
                    new Vector3(meshBounds.max.x, meshBounds.min.y, meshBounds.max.z),
                    meshBounds.max
                };
                
                foreach (Vector3 corner in meshCorners) {
                    if (!sceneBoundingBox.Contains(corner)) {
                        isFullyContained = false;
                        break;
                    }
                }

                if (!isFullyContained)
                    renderer.gameObject.SetActive(false);
            }
            parent.transform.position = Vector3.zero;
        }

        public static Vector4 CalculateScenePlane(List<Vector2Int> decodedParcels)
        {
            List<ParcelCorners> parcelCorners = new List<ParcelCorners>();
            foreach (var decodedParcel in decodedParcels)
                parcelCorners.Add(CalculateCorners(decodedParcel));

            float circumscribedPlaneMinX = float.MaxValue;
            float circumscribedPlaneMaxX = float.MinValue;
            float circumscribedPlaneMinZ = float.MaxValue;
            float circumscribedPlaneMaxZ = float.MinValue;

            for (int j = 0; j < parcelCorners.Count; j++)
            {
                var corners = parcelCorners[j];

                circumscribedPlaneMinX = Mathf.Min(corners.minXZ.x, circumscribedPlaneMinX);
                circumscribedPlaneMaxX = Mathf.Max(corners.maxXZ.x, circumscribedPlaneMaxX);
                circumscribedPlaneMinZ = Mathf.Min(corners.minXZ.z, circumscribedPlaneMinZ);
                circumscribedPlaneMaxZ = Mathf.Max(corners.maxXZ.z, circumscribedPlaneMaxZ);
            }

            // to prevent on-boundary flickering (float accuracy) extend the circumscribed planes a little bit

           

            circumscribedPlaneMinX -= EXTEND_AMOUNT;
            circumscribedPlaneMaxX += EXTEND_AMOUNT;
            circumscribedPlaneMinZ -= EXTEND_AMOUNT;
            circumscribedPlaneMaxZ += EXTEND_AMOUNT;


            var sceneCircumscribedPlanes = new SceneCircumscribedPlanes(circumscribedPlaneMinX, circumscribedPlaneMaxX, circumscribedPlaneMinZ, circumscribedPlaneMaxZ);
            return new Vector4(sceneCircumscribedPlanes.MinX, sceneCircumscribedPlanes.MaxX, sceneCircumscribedPlanes.MinZ, sceneCircumscribedPlanes.MaxZ);
        }
    }
}