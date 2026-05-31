#!/usr/bin/env python3
"""Corpus-wide validation sweep (no Unity).

For every downloaded v49 glb bundle: fetch its source glb from the catalyst,
re-encode it with our encoder, and compare against the production bundle via
UnityPy — object histogram + deep semantic field-diff. Tally results and flag
any non-opaque (alpha) materials (which would unblock alpha-mode work).

Usage:
    /usr/bin/python3 scripts/sweep-validate.py <downloaded-scenes-dir> [glb-cache-dir]

Requires: UnityPy, the `encode-glb-to-file` binary built
(`cargo build --bin encode-glb-to-file --no-default-features`).
"""
import json
import os
import struct
import subprocess
import sys
import tempfile
import urllib.request
from collections import Counter, defaultdict

CATALYST = "https://peer.decentraland.org/content/contents/"
ENCODER = "./target/debug/encode-glb-to-file"


def fetch_glb(h, cache):
    p = os.path.join(cache, h + ".glb")
    if os.path.exists(p) and os.path.getsize(p) > 0:
        return p
    try:
        req = urllib.request.Request(CATALYST + h, headers={"User-Agent": "dcl-encoder-sweep/1.0"})
        data = urllib.request.urlopen(req, timeout=30).read()
        if data[:4] != b"glTF":
            return None
        open(p, "wb").write(data)
        return p
    except Exception:
        return None


def glb_alpha_modes(glb_path):
    d = open(glb_path, "rb").read()
    jl = struct.unpack("<I", d[12:16])[0]
    j = json.loads(d[20:20 + jl])
    return set(m.get("alphaMode", "OPAQUE") for m in j.get("materials", []))


def fields(o, t):
    g = lambda n, d=0: getattr(o, n, d)
    if t == "GameObject":
        return {"name": o.m_Name, "layer": int(g("m_Layer")), "components": len(g("m_Component", []) or [])}
    if t == "Transform":
        v = lambda n: tuple(round(getattr(getattr(o, n, None), a, 0.0), 3) for a in ("x", "y", "z", "w") if hasattr(getattr(o, n, None), a))
        return {"pos": v("m_LocalPosition"), "rot": v("m_LocalRotation"), "scale": v("m_LocalScale")}
    if t == "Mesh":
        vd = g("m_VertexData", None)
        return {"name": o.m_Name, "usage": int(g("m_MeshUsageFlags")), "verts": int(getattr(vd, "m_VertexCount", 0)) if vd else 0}
    if t == "Material":
        return {"name": o.m_Name}
    if t == "Texture2D":
        return {"w": int(o.m_Width), "fmt": int(o.m_TextureFormat)}
    if t == "AnimationClip":
        return {"name": o.m_Name, "legacy": int(g("m_Legacy"))}
    return {}


def inspect(path):
    import UnityPy
    env = UnityPy.load(path)
    hist = Counter()
    by_type = defaultdict(list)
    fails = 0
    for o in env.objects:
        hist[o.type.name] += 1
        try:
            by_type[o.type.name].append(fields(o.read(), o.type.name))
        except Exception:
            fails += 1
    return hist, by_type, fails


def main():
    try:
        import UnityPy  # noqa: F401
    except ImportError:
        print("UnityPy not installed (use /usr/bin/python3 -m pip install --user UnityPy)")
        sys.exit(1)
    root = sys.argv[1]
    cache = sys.argv[2] if len(sys.argv) > 2 else "/tmp/glbsrc"
    os.makedirs(cache, exist_ok=True)

    bundles = []
    for dirpath, _, files in os.walk(os.path.join(root, "v49")):
        for f in files:
            if f.endswith("_windows") and f.count("_") >= 2:  # 3-segment = glb
                bundles.append(os.path.join(dirpath, f))

    n = match_hist = total_objs = match_objs = alpha_scenes = no_src = 0
    for b in sorted(set(bundles)):
        h = os.path.basename(b).split("_")[0]
        src = fetch_glb(h, cache)
        if not src:
            no_src += 1
            continue
        n += 1
        alphas = glb_alpha_modes(src)
        if alphas - {"OPAQUE"}:
            alpha_scenes += 1
            print(f"  [ALPHA] {h[:18]}: {alphas}")
        out = tempfile.mktemp(suffix=".ab")
        # In production the scene-converter passes the animation method (emote →
        # Mecanim) from the entity type / `_emote.glb` filename, which this
        # corpus harness doesn't have (bundles are keyed by content hash). Detect
        # emote-ness from the production bundle itself (an Animator ⇒ Mecanim) so
        # the encoder can be told, mirroring what the real pipeline supplies.
        env = dict(os.environ)
        try:
            ph, _, _ = inspect(b)
            if ph.get("Animator", 0) > 0:
                env["EMOTE"] = "1"
        except Exception:
            pass
        r = subprocess.run([ENCODER, src, out, "windows", h], capture_output=True, env=env)
        if r.returncode != 0:
            print(f"  [ENC-FAIL] {h[:18]}: {r.stderr.decode()[:80]}")
            continue
        try:
            oh, ob, _ = inspect(out)
            rh, rb, _ = inspect(b)
        except Exception as e:
            print(f"  [LOAD-FAIL] {h[:18]}: {e}")
            continue
        finally:
            if os.path.exists(out):
                os.remove(out)
        if oh == rh:
            match_hist += 1
        else:
            d = {k: (oh.get(k, 0), rh.get(k, 0)) for k in set(oh) | set(rh) if oh.get(k, 0) != rh.get(k, 0)}
            print(f"  [HIST-DIFF] {h[:18]}: {d}")
        # field match tally
        for t in oh:
            rl = rb.get(t, [])
            rk = defaultdict(list)
            for r2 in rl:
                rk[r2.get("name", str(sorted(r2.items())))].append(r2)
            for o2 in ob.get(t, []):
                total_objs += 1
                key = o2.get("name", str(sorted(o2.items())))
                cand = rk[key].pop(0) if rk.get(key) else (rl[0] if rl else None)
                if cand and all(o2.get(x) == cand.get(x) for x in o2):
                    match_objs += 1

    print(f"\n[sweep] {n} scenes ({no_src} source 404/none) | histogram match: {match_hist}/{n} "
          f"| field match: {match_objs}/{total_objs} objects | alpha scenes: {alpha_scenes}")


if __name__ == "__main__":
    main()
