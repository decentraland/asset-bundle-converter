using System.Collections.Generic;
using System.Linq;
using UnityEngine;

namespace AssetBundleConverter.LODsConverter.Utils
{
    public class SceneCircumscribedPlanesCalculator
    {
        public const float PARCEL_SIZE = 16.0f;

        public static ParcelCorners CalculateCorners(Vector2Int parcelPosition)
        {
            var min = GetPositionByParcelPosition(parcelPosition);
            return new ParcelCorners(min, min + new Vector3(0, 0, PARCEL_SIZE), min + new Vector3(PARCEL_SIZE, 0, PARCEL_SIZE), min + new Vector3(PARCEL_SIZE, 0, 0));
        }

        public static Vector3 GetPositionByParcelPosition(Vector2Int parcelPosition)
        {
            return new Vector3 (parcelPosition.x * PARCEL_SIZE, 0.0f, parcelPosition.y * PARCEL_SIZE);
        }

        public readonly struct SceneCircumscribedPlanes
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

        public readonly struct ParcelCorners
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

        public static Vector4 CalculatePlane(List<Vector2Int> decodedParcels)
        {
            IReadOnlyList<ParcelCorners> parcelCorners = new List<ParcelCorners>(decodedParcels.Select(CalculateCorners));


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

            const float EXTEND_AMOUNT = 0.05f;

            circumscribedPlaneMinX -= EXTEND_AMOUNT;
            circumscribedPlaneMaxX += EXTEND_AMOUNT;
            circumscribedPlaneMinZ -= EXTEND_AMOUNT;
            circumscribedPlaneMaxZ += EXTEND_AMOUNT;


            var sceneCircumscribedPlanes = new SceneCircumscribedPlanes(circumscribedPlaneMinX, circumscribedPlaneMaxX, circumscribedPlaneMinZ, circumscribedPlaneMaxZ);
            return new Vector4(sceneCircumscribedPlanes.MinX, sceneCircumscribedPlanes.MaxX, sceneCircumscribedPlanes.MinZ, sceneCircumscribedPlanes.MaxZ);
        }
    }
}