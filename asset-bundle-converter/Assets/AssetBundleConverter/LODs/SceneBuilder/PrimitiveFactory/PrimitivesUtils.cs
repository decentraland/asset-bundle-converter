// unset:none
using System.Collections.Generic;
using System.Linq;
using UnityEngine;

namespace Utility.Primitives
{
    public static class PrimitivesUtils
    {
        public static List<Vector2> FloatArrayToV2List(IList<float> uvs)
        {
            var uvsResultIndex = 0;
            var uvsResult = new Vector2[uvs.Count / 2];

            for (var i = 0; i < uvs.Count && uvsResultIndex < uvsResult.Length;)
                uvsResult[uvsResultIndex++] = new Vector2(uvs[i++], uvs[i++]);

            return uvsResult.ToList();
        }
    }
}
