#!/usr/bin/env python3
"""Deep semantic field-level diff of our bundle vs a production bundle.

Goes beyond the object-histogram check: loads both with UnityPy, matches
objects by (type, name/order), and compares the FIELD VALUES that should
match between our encoder and Unity — Transform TRS, GameObject layer/tag/
component-count, MeshRenderer flags/material-count, Material properties,
Mesh stats, Texture2D format/dims, AnimationClip flags. Path-IDs and the BC7
pixel bytes legitimately differ, so those are excluded.

Usage:
    /usr/bin/python3 scripts/deep-diff-unitypy.py <ours.assetbundle> <real.assetbundle>
"""
import sys
from collections import defaultdict


def f(v):
    try:
        return round(float(v), 4)
    except Exception:
        return v


def vec(o, *names):
    for n in names:
        v = getattr(o, n, None)
        if v is not None:
            return tuple(round(getattr(v, a, 0.0), 4) for a in ("x", "y", "z", "w") if hasattr(v, a))
    return None


def fields(o, tname):
    """Return the comparable semantic fields for an object."""
    d = {}
    if tname == "GameObject":
        d["name"] = o.m_Name
        d["layer"] = int(getattr(o, "m_Layer", 0))
        d["tag"] = int(getattr(o, "m_Tag", 0))
        d["active"] = bool(getattr(o, "m_IsActive", True))
        d["components"] = len(getattr(o, "m_Component", []) or [])
    elif tname == "Transform":
        d["pos"] = vec(o, "m_LocalPosition")
        d["rot"] = vec(o, "m_LocalRotation")
        d["scale"] = vec(o, "m_LocalScale")
        d["children"] = len(getattr(o, "m_Children", []) or [])
    elif tname == "MeshRenderer":
        d["enabled"] = int(getattr(o, "m_Enabled", 0))
        d["castShadows"] = int(getattr(o, "m_CastShadows", 0))
        d["receiveShadows"] = int(getattr(o, "m_ReceiveShadows", 0))
        d["materials"] = len(getattr(o, "m_Materials", []) or [])
    elif tname == "MeshCollider":
        d["enabled"] = int(getattr(o, "m_Enabled", 0))
        d["convex"] = int(getattr(o, "m_Convex", 0))
    elif tname == "Mesh":
        d["name"] = o.m_Name
        d["usageFlags"] = int(getattr(o, "m_MeshUsageFlags", 0))
        d["submeshes"] = len(getattr(o, "m_SubMeshes", []) or [])
        vd = getattr(o, "m_VertexData", None)
        d["verts"] = int(getattr(vd, "m_VertexCount", 0)) if vd else 0
    elif tname == "Material":
        d["name"] = o.m_Name
        sp = getattr(o, "m_SavedProperties", None)
        if sp:
            cols = {p[0]: f(getattr(p[1], "r", 0)) for p in getattr(sp, "m_Colors", [])}
            flts = {p[0]: f(p[1]) for p in getattr(sp, "m_Floats", [])}
            d["_BaseColor.r"] = cols.get("_BaseColor")
            d["_Metallic"] = flts.get("_Metallic")
            d["_Smoothness"] = flts.get("_Smoothness")
            d["_Cull"] = flts.get("_Cull")
            d["nFloats"] = len(flts)
            d["nColors"] = len(cols)
    elif tname == "Texture2D":
        d["w"] = int(o.m_Width)
        d["h"] = int(o.m_Height)
        d["fmt"] = int(o.m_TextureFormat)
        d["mips"] = int(o.m_MipCount)
    elif tname == "AnimationClip":
        d["name"] = o.m_Name
        d["legacy"] = int(getattr(o, "m_Legacy", 0))
        d["sampleRate"] = f(getattr(o, "m_SampleRate", 0))
    elif tname == "Animation":
        d["clips"] = len(getattr(o, "m_Animations", []) or [])
    return d


def collect(path):
    import UnityPy
    env = UnityPy.load(path)
    by_type = defaultdict(list)
    for o in env.objects:
        t = o.type.name
        try:
            by_type[t].append(fields(o.read(), t))
        except Exception as e:  # noqa: BLE001
            by_type[t].append({"READ_ERROR": str(e)})
    return by_type


def match_key(rec):
    # Match objects by name when present, else a stable sorted-fields key.
    return rec.get("name", tuple(sorted((k, str(v)) for k, v in rec.items())))


def main():
    if len(sys.argv) != 3:
        print(__doc__)
        sys.exit(2)
    try:
        import UnityPy  # noqa: F401
    except ImportError:
        print("UnityPy not installed. Run: /usr/bin/python3 -m pip install --user UnityPy")
        sys.exit(1)

    ours = collect(sys.argv[1])
    real = collect(sys.argv[2])
    total = 0
    mismatches = 0
    for t in sorted(set(ours) | set(real)):
        o_list = ours.get(t, [])
        r_list = real.get(t, [])
        # Pair by match key, falling back to positional.
        r_by_key = defaultdict(list)
        for r in r_list:
            r_by_key[match_key(r)].append(r)
        for o in o_list:
            total += 1
            k = match_key(o)
            r = r_by_key[k].pop(0) if r_by_key.get(k) else (r_list[0] if r_list else None)
            if r is None:
                print(f"  [{t}] ours has no real match: {o}")
                mismatches += 1
                continue
            diff = {key: (o.get(key), r.get(key)) for key in o if o.get(key) != r.get(key)}
            if diff:
                mismatches += 1
                print(f"  [{t}] {k!r} field diffs: {diff}")
    print(f"\n[deep-diff] {total - mismatches}/{total} objects match production on all compared fields")
    sys.exit(0 if mismatches == 0 else 1)


if __name__ == "__main__":
    main()
