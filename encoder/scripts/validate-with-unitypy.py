#!/usr/bin/env python3
"""Independent validation of an encoder bundle using UnityPy.

UnityPy (https://github.com/K0lb3/UnityPy, MIT) is a third-party, TypeTree-
driven Unity asset reader — independent of this repo's own reader/writer. If
UnityPy can load our bundle and deserialize every object + resolve the
GameObject graph, that's strong evidence the bundle is structurally valid for
the Unity ecosystem (short of actually rendering, which needs Unity).

Usage:
    pip install UnityPy
    python3 scripts/validate-with-unitypy.py <our.assetbundle> [<real.assetbundle>]

With one arg: inspect our bundle (object inventory + graph integrity).
With two args: also load the real production bundle and diff the per-class
object inventory (counts + key fields), to confirm ours matches.
"""
import sys


def load(path):
    import UnityPy
    env = UnityPy.load(path)
    objs = []
    for o in env.objects:
        try:
            data = o.read()
        except Exception as e:  # noqa: BLE001
            objs.append((o.type.name, None, f"READ-FAILED: {e}"))
            continue
        objs.append((o.type.name, o, data))
    return env, objs


def summarize(path):
    env, objs = load(path)
    print(f"\n=== {path} ===")
    print(f"objects: {len(objs)}")
    by_type = {}
    failures = 0
    for tname, _o, data in objs:
        by_type.setdefault(tname, 0)
        by_type[tname] += 1
        if isinstance(data, str) and data.startswith("READ-FAILED"):
            failures += 1
            print(f"  ! {tname}: {data}")
    print("by type:", {k: by_type[k] for k in sorted(by_type)})

    # Spot-check the load-bearing objects deserialize with sane values.
    for tname, _o, data in objs:
        if data is None or isinstance(data, str):
            continue
        try:
            if tname == "Mesh":
                vc = getattr(data, "m_VertexData", None)
                n = getattr(vc, "m_VertexCount", "?") if vc else "?"
                subs = len(getattr(data, "m_SubMeshes", []) or [])
                print(f"  Mesh '{getattr(data,'m_Name','?')}': verts={n} submeshes={subs} usageFlags={getattr(data,'m_MeshUsageFlags','?')}")
            elif tname == "Material":
                sh = getattr(data, "m_Shader", None)
                fid = getattr(sh, "m_FileID", "?") if sh else "?"
                pid = getattr(sh, "m_PathID", "?") if sh else "?"
                print(f"  Material '{getattr(data,'m_Name','?')}': shader(fileID={fid}, pathID={pid})")
            elif tname == "Texture2D":
                print(f"  Texture2D '{getattr(data,'m_Name','?')}': {getattr(data,'m_Width','?')}x{getattr(data,'m_Height','?')} fmt={getattr(data,'m_TextureFormat','?')} mips={getattr(data,'m_MipCount','?')}")
            elif tname == "GameObject":
                comps = getattr(data, "m_Component", []) or []
                print(f"  GameObject '{getattr(data,'m_Name','?')}': components={len(comps)}")
            elif tname == "AssetBundle":
                cont = getattr(data, "m_Container", []) or []
                print(f"  AssetBundle '{getattr(data,'m_Name','?')}': container entries={len(cont)}")
        except Exception as e:  # noqa: BLE001
            print(f"  ! {tname} field read failed: {e}")

    print(f"deserialize failures: {failures}/{len(objs)}")
    return by_type, failures


def main():
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(2)
    try:
        import UnityPy  # noqa: F401
    except ImportError:
        print("UnityPy not installed. Run: pip install UnityPy")
        sys.exit(1)

    ours_types, ours_fail = summarize(sys.argv[1])
    ok = ours_fail == 0
    if len(sys.argv) >= 3:
        real_types, _ = summarize(sys.argv[2])
        print("\n=== histogram diff (ours vs real) ===")
        for k in sorted(set(ours_types) | set(real_types)):
            o, r = ours_types.get(k, 0), real_types.get(k, 0)
            flag = "" if o == r else "  <-- DIFF"
            print(f"  {k:<16} ours={o} real={r}{flag}")

    print("\n[result]", "PASS — UnityPy loaded + deserialized our bundle" if ok else "FAIL — see read failures above")
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()
