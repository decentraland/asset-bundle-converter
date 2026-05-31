#!/usr/bin/env python3
"""Mac-target validation (no Unity).

The main sweep only validates Windows. Geometry is platform-independent, so the
Mac-specific surface is the shader-bundle CAB external (archive:/CAB-5ba4993b…)
and the target-platform id. For a diverse set of corpus entities, this fetches
their Mac glb bundles from ab-cdn, re-encodes the source glb with target=mac,
and asserts: (a) object histogram matches, (b) the Mac shader CAB is registered
as a SerializedFile external.

Usage: /usr/bin/python3 scripts/mac-validate.py <entity_id> [<entity_id> ...]
(reads source glbs from /tmp/glbsrc, populated by the Windows sweep.)
"""
import os
import subprocess
import sys
import tempfile
import urllib.request
from collections import Counter

import UnityPy

CDN = "https://ab-cdn.decentraland.org"
UA = "dcl-encoder-mac-validate/1.0"
MAC_CAB = "CAB-5ba4993b7ea166819a0af9aec5b25b8c"
ENCODER = "./target/debug/encode-glb-to-file"


def fetch(url):
    import time
    for attempt in range(4):
        try:
            return urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": UA}), timeout=60).read()
        except Exception as e:
            if attempt == 3:
                print(f"    fetch failed ({e}): {url[-60:]}")
                return None
            time.sleep(0.5 * (attempt + 1))
    return None


def hist(path):
    return Counter(o.type.name for o in UnityPy.load(path).objects)


def main():
    import json
    ok = fail = 0
    for eid in sys.argv[1:]:
        man = fetch(f"{CDN}/manifest/{eid}_mac.json")
        if not man:
            print(f"  [skip] {eid[:18]}: no mac manifest")
            continue
        files = [f for f in json.loads(man).get("files", []) if f.count("_") >= 2 and not f.endswith(".json")]
        for f in files:
            h = f.split("_")[0]
            src = f"/tmp/glbsrc/{h}.glb"
            if not os.path.exists(src):
                continue
            real = fetch(f"{CDN}/{json.loads(man)['version']}/{eid}/{f}")
            if not real:
                continue
            rb = tempfile.mktemp(suffix=".ab"); open(rb, "wb").write(real)
            ours = tempfile.mktemp(suffix=".ab")
            env = dict(os.environ)
            if hist(rb).get("Animator", 0) > 0:
                env["EMOTE"] = "1"
            r = subprocess.run([ENCODER, src, ours, "mac", h], capture_output=True, env=env)
            if r.returncode != 0:
                print(f"  [enc-fail] {h[:16]}: {r.stderr.decode()[:70]}"); fail += 1; continue
            oh, rh = hist(ours), hist(rb)
            diff = {k: (oh.get(k, 0), rh.get(k, 0)) for k in set(oh) | set(rh) if oh.get(k, 0) != rh.get(k, 0)}
            # assert our bundle carries the Mac shader CAB external.
            blob = open(ours, "rb").read()
            mac_cab_ok = MAC_CAB.encode() in blob
            status = "OK" if (not diff and mac_cab_ok) else f"DIFF {diff} mac_cab={mac_cab_ok}"
            print(f"  {h[:16]} ({eid[:12]}): {status}")
            if not diff and mac_cab_ok:
                ok += 1
            else:
                fail += 1
            for p in (rb, ours):
                os.path.exists(p) and os.remove(p)
            break  # one glb per entity is enough to validate the mac path
    print(f"\n[mac] {ok} ok, {fail} fail")
    sys.exit(1 if fail else 0)


if __name__ == "__main__":
    main()
