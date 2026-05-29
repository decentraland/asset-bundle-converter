# Vendored bake fixtures

This directory holds pre-extracted artifacts that the bake driver
(`consumer-server/src/bake-encoder-artifacts.ts`) consumes without
needing Unity at bake time. The artifacts here come from one-time
extractions against externally-available data (Unity bundles already
on `ab-cdn`, or static Unity binaries) — re-extract only when the
Explorer upgrades its Unity version.

## `typetrees/`

One binary file per Unity version the Explorer targets. Naming:
`typetrees/<unity_version>.bin`, e.g. `typetrees/2021.3.20f1.bin`.

### What's in it

A flat binary dump of TypeTree definitions for every Unity class the
encoder serialises into a bundle:

- `Mesh` (ClassID 43)
- `Material` (ClassID 21)
- `Texture2D` (ClassID 28)
- `GameObject` (ClassID 1)
- `Transform` (ClassID 4)
- `MeshFilter` (ClassID 33)
- `MeshRenderer` (ClassID 23)
- `SkinnedMeshRenderer` (ClassID 137)
- `AnimationClip` (ClassID 74) — phase 3 (wearables/emotes)
- `AnimatorController` (ClassID 91) — phase 3 (wearables/emotes)
- `AssetBundleManifest`-related types as needed
- The `MonoBehaviour` script that wraps our inline `metadata.json`
  TextAsset

The exact wire format is the Rust encoder's responsibility — it loads
this file at startup, parses it into a `TypeTreeDb`, and uses it to
drive object serialisation. The bake driver treats it as opaque bytes
and copies it verbatim into each per-target bake output.

### How to (re-)extract — Unity-free procedure

The TypeTree definitions are determined by the **Unity engine version**,
not by anything we ship. Pick ONE existing Unity-built AssetBundle the
Explorer is already loading, run the in-crate extractor against it, and
commit the result. The TypeTrees inside that bundle are exactly what the
Explorer's loader expects.

#### The in-crate extractor — recommended path

A Rust binary in this crate does the extraction directly. No Python, no
.NET, no Unity:

```bash
# 1. Download a recent Windows-target bundle from production.
#    Any conversion that completed in the last week works; pick one
#    you know about (e.g. from a recent SQS message log) or grep for
#    a hash on ab-cdn.
curl -o /tmp/source.assetbundle \
  "https://ab-cdn.decentraland.org/v48/assets/<hash>_windows"

# 2. Run the extractor. The output path is conventionally
#    encoder/baked-fixtures/typetrees/<unity_version>.bin so the
#    bake driver picks it up automatically.
cd encoder
cargo run --bin extract-typetrees --no-default-features -- \
  /tmp/source.assetbundle \
  baked-fixtures/typetrees/2021.3.20f1.bin

# 3. Commit. The extractor logs each class_id it found — verify
#    coverage includes the classes the encoder needs (Mesh=43,
#    Material=21, Texture2D=28, GameObject=1, Transform=4,
#    MeshFilter=33, MeshRenderer=23, SkinnedMeshRenderer=137, ...).
```

The `--no-default-features` flag is load-bearing: it tells cargo to
skip the napi-rs bindings (which need a Node host to link). The
extractor uses only the Rust-side encoder modules.

#### Choosing a source bundle

Pick a glb bundle (not a texture-only bundle) so the extracted type
table covers the full class set our encoder needs. A glb bundle's
SerializedFile carries types for every component the GameObject
references — `GameObject`, `Transform`, `MeshFilter`, `MeshRenderer`,
`Mesh`, `Material`, plus the dep-referenced `Texture2D` types from
material PPtrs. A texture-only bundle would only give us
`Texture2D`.

#### Alternative tools (not recommended, but supported)

If the in-crate extractor breaks (e.g. Unity's SerializedFile format
changes), these external tools can extract TypeTrees too:

- **UnityPy** (Python) — `pip install UnityPy`. Adapter needed to
  convert UnityPy's parsed TypeTree objects to our binary format.
- **AssetRipper** (.NET / C#) — repo: github.com/AssetRipper/AssetRipper.
  More thorough; produces TypeTree dumps in various formats. Adapter
  needed for our format.

In practice, the in-crate extractor stays in sync with our reader
because they share code. The external tools are useful for
verification.

#### Source bundle to extract from

Pick a known-good Unity-built bundle from `ab-cdn`:

```bash
curl -o /tmp/source.assetbundle \
  "https://ab-cdn.decentraland.org/v48/assets/<some-known-hash>_windows"
```

Any successfully-converted scene bundle works — the TypeTrees inside it
are the canonical schemas the Explorer accepts.

#### Output

Save the extracted dump as `typetrees/<unity_version>.bin`. Commit it.
The bake driver picks up the new file on the next `yarn bake` run; no
code changes needed.

### When to re-extract

- The Explorer's `ProjectSettings.asset` bumps Unity version (`m_EditorVersion`).
- The Explorer adds a new Component / asset type that scenes can serialise
  (rare in practice for runtime-loaded bundles).

Otherwise the file is stable — once extracted, it sits here for the life
of the Unity version.

### What about per-target?

TypeTrees are class schemas — they depend on Unity version, not on
build target (Windows / Mac / WebGL). The same `typetrees.bin` is
copied into all three target outputs by the bake driver. If a future
Unity version surfaces per-target TypeTree differences, the bake driver
can branch on target when copying.
