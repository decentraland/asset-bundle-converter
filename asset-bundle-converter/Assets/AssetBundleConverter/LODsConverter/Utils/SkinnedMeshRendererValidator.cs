using UnityEngine;

namespace AssetBundleConverter.LODsConverter.Utils
{
    public class SkinnedMeshRendererValidator
    {
        public static void ValidateSkinnedMeshRenderer(GameObject model)
        {
            var renderers = model.GetComponentsInChildren<SkinnedMeshRenderer>();
            foreach (var renderer in renderers)
            {
                if (ArrayContainsNaN(renderer.sharedMesh.bindposes))
                    renderer.gameObject.SetActive(false);
            }
        }

        private static bool ValidateSkinnedMeshRenderer(SkinnedMeshRenderer skinnedMeshRenderer)
        {
            if (skinnedMeshRenderer.sharedMesh.bindposes.Length == 0)
            {
                return false;
            }

            if (ArrayContainsNaN(skinnedMeshRenderer.sharedMesh.bindposes))
            {
                return false;
            }

            return true;
        }


        private static bool MatrixContainsNaN(Matrix4x4 matrix)
        {
            for (int i = 0; i < 16; i++)
            {
                if (float.IsNaN(matrix[i]))
                {
                    return true;
                }
            }

            return false;
        }

        private static bool ArrayContainsNaN(Matrix4x4[] matrices)
        {
            foreach (var matrix in matrices)
            {
                if (MatrixContainsNaN(matrix))
                {
                    return true;
                }
            }

            return false;
        }
    }
}