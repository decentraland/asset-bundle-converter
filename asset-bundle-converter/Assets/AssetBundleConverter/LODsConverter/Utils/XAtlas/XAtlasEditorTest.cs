using UnityEngine;
using UnityEditor;
using System;
using System.Runtime.InteropServices;

public class XAtlasEditorTest
{
    [DllImport("xatlas", CallingConvention = CallingConvention.Cdecl)]
    private static extern IntPtr xatlasCreate();

    [DllImport("xatlas", CallingConvention = CallingConvention.Cdecl)]
    private static extern void xatlasDestroy(IntPtr atlas);

    [MenuItem("Tools/Test XAtlas DLL")]
    public static void TestXAtlasDLL()
    {
        Debug.Log("TEST 1: About to call xatlasCreate...");

        try
        {
            IntPtr atlas = xatlasCreate();
            Debug.Log($"TEST 2: xatlasCreate returned: {atlas}");

            if (atlas != IntPtr.Zero)
            {
                Debug.Log("TEST 3: About to call xatlasDestroy...");
                xatlasDestroy(atlas);
                Debug.Log("TEST 4: xatlasDestroy complete - SUCCESS!");
            }
            else
            {
                Debug.LogError("TEST FAILED: xatlasCreate returned null pointer");
            }
        }
        catch (Exception e)
        {
            Debug.LogError($"TEST FAILED with exception: {e.Message}\n{e.StackTrace}");
        }
    }
}
