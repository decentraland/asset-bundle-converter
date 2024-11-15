using Unity.Jobs;
using Unity.Collections;
using Unity.Burst;
using Unity.Mathematics;

[BurstCompile]
public struct OctreeBuilderJob : IJobParallelFor
{
    [ReadOnly] public NativeArray<float3> Positions;
    [ReadOnly] public NativeArray<float3> Sizes;
    public NativeArray<int> NodeIndices;
    public float3 TreeCenter;
    public float3 TreeSize;
    public int MaxDepth;

    public void Execute(int index)
    {
        float3 position = Positions[index];
        float3 size = Sizes[index];
        int nodeIndex = 0;
        int depth = 0;

        while (depth < MaxDepth)
        {
            float3 nodeCenter = TreeCenter;
            float3 nodeSize = TreeSize;

            for (int i = 0; i < depth; i++)
            {
                nodeSize *= 0.5f;
                int childIndex = 0;
                if (position.x >= nodeCenter.x) { childIndex |= 1; nodeCenter.x += nodeSize.x * 0.5f; } else { nodeCenter.x -= nodeSize.x * 0.5f; }
                if (position.y >= nodeCenter.y) { childIndex |= 2; nodeCenter.y += nodeSize.y * 0.5f; } else { nodeCenter.y -= nodeSize.y * 0.5f; }
                if (position.z >= nodeCenter.z) { childIndex |= 4; nodeCenter.z += nodeSize.z * 0.5f; } else { nodeCenter.z -= nodeSize.z * 0.5f; }
                nodeIndex = nodeIndex * 8 + childIndex + 1;
            }

            if (math.all(size <= nodeSize))
                break;

            depth++;
        }

        NodeIndices[index] = nodeIndex;
    }
}