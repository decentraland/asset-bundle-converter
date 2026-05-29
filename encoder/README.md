# `dcl-asset-bundle-encoder`

A standalone Rust + napi-rs encoder that produces Unity-compatible
AssetBundles (UnityFS containers) **without running Unity**, intended to
replace per-scene Unity editor spawns in the consumer-server conversion
path. See the top-level `CLAUDE.md` "Rust encoder scaffold" changelog for
the full design and status.

What the code does, at a glance:
- Reads/writes the **UnityFS** container format (header, LZ4 block-info +
  directory, chunked data blocks).
- Reads/writes the **SerializedFile** container (header, type table,
  object table, externals) for Unity 2021.3 / 2022.3 / Unity 6.
- Parses and emits **TypeTree**-driven object serialization for the Unity
  classes that scene bundles contain (Mesh, Material, Texture2D,
  GameObject, Transform, MeshFilter, MeshRenderer, AssetBundle, …).
- Fetches scene content from a Decentraland catalyst (HTTP), mirroring
  the existing consumer-server fetch policy.
- Decodes PNG/JPG textures and parses glTF/glb geometry.

All of the format understanding above was obtained by **reverse-
engineering the on-disk byte layout for interoperability** — i.e. so the
files we write can be loaded by the same Unity-based Explorer client that
already consumes Unity-produced bundles.

---

## ⚠️ Legal & Licensing Considerations

> **This is not legal advice.** It is a good-faith engineering record of
> where this code's knowledge came from, what it does, and which licenses
> are involved, written so that qualified counsel can make the actual
> determinations. Nothing here should be treated as a legal conclusion.
> **Have legal review this section before any public release or
> distribution of the `encoder/` crate.**

This repository is licensed **Apache-2.0**. That choice interacts with
the items below — most importantly the AssetRipper reference — so they are
recorded here for review.

### 1. AssetRipper (GPL-3.0) — format reference. **Highest-priority item.**

During development, the **AssetRipper** project
(<https://github.com/AssetRipper/AssetRipper>, licensed **GPL-3.0**) was
used as a *reference for understanding* the UnityFS / SerializedFile /
TypeTree byte layouts. AssetRipper is the most complete public
reverse-engineering of these formats.

- **What was and was not taken.** The Rust implementation here was written
  from an *understanding of the file format* (field offsets, byte orders,
  alignment rules, flag bit meanings) — facts about how to interoperate
  with the format. AssetRipper's **source code was not copied or
  mechanically translated** into this crate. The code organization, types,
  and logic are original.
- **Why the distinction matters.** Copyright protects expression, not
  ideas, facts, or interoperability information. File formats themselves
  and the factual layout details needed to read/write them are generally
  not copyrightable (e.g. 17 U.S.C. §102(b); the interface/interoperability
  direction of *Google v. Oracle*; in the EU, the Software Directive
  2009/24/EC Art. 1(2) excludes ideas/principles and Art. 6 permits
  decompilation for interoperability). GPL's copyleft attaches to the
  *code* and is triggered by creating a **derivative work** of that code —
  not by learning a format from a GPL project and then writing original
  code.
- **The Apache-2.0 conflict.** GPL-3.0 is **incompatible** with Apache-2.0
  in the sense that GPL-3.0-licensed *code* cannot be redistributed as part
  of an Apache-2.0 work. **If** any AssetRipper source were found to have
  been copied or closely translated into this crate, it would be both a
  GPL violation and inconsistent with this repo's Apache-2.0 license.
- **Recommended action.** Before release, have an engineer + counsel do a
  **provenance audit** of the format modules (`encode/unityfs_writer.rs`,
  `encode/serialized_file*.rs`, `encode/type_tree*.rs`) to confirm no
  AssetRipper code was copied. The modules carry comments citing
  AssetRipper as a *reference*; those citations document where the
  *understanding* came from, not where code came from. If certainty is
  required, the format layer could additionally be re-derived purely from
  (a) Khronos/Unity public documentation and (b) black-box inspection of
  bundles the org already owns the right to inspect.

### 2. UnityPy (MIT) — alternative reference

**UnityPy** (<https://github.com/K0lb3/UnityPy>, **MIT**) was also
referenced as an alternative format reader. MIT is permissive; the same
"reference, not copied" statement in §1 applies. MIT would only require
attribution *if* code were copied, which it was not.

### 3. Unity proprietary file formats (UnityFS / SerializedFile / TypeTree)

These are Unity Technologies' proprietary container/serialization formats.
The reverse-engineering here is on **relatively low-risk footing** under
copyright, with the genuine Unity exposure being **contractual** (EULA),
not copyright. Specifics:

- **We reverse-engineered *output files*, not Unity software.** The format
  knowledge came from observing the byte layout of AssetBundles that
  Unity produced (pulled from the public ab-cdn, originally built by the
  org's own licensed converter). We did **not** decompile, disassemble,
  or inspect the Unity Editor / Engine **binaries**, and we use, link, and
  redistribute **no** Unity engine code. Black-box observation of output
  files for interoperability is the safest reverse-engineering category —
  more defensible than the binary decompilation that the leading cases
  below actually blessed.
- **File formats are not copyrightable.** Copyright protects creative
  expression, not the factual layout needed to read/write a format
  (17 U.S.C. §102(b)). Producing byte-compatible files Unity's runtime can
  load is interoperability, not copying.
- **Interoperability RE is well-supported.** US fair-use precedent
  (*Sega v. Accolade*, *Sony v. Connectix*, *Atari v. Nintendo*) and the
  EU Software Directive 2009/24/EC Art. 6 protect reverse-engineering for
  interoperability — and those cases involved decompiling *software*,
  which is more aggressive than reading output files.
- **DMCA §1201 (anti-circumvention) does not appear to apply.** That
  statute targets circumventing access-control / DRM. Unity bundles are
  LZ4-*compressed*, not encrypted or access-gated; compression is not a
  technological protection measure, so nothing is "circumvented."
- **The real Unity exposure is contractual.** Unity's EULA / Terms of
  Service may contain anti-reverse-engineering and/or anti-"competing
  tool" provisions that bind *by contract* beyond what copyright allows.
  The org accepted such terms by running the Unity Editor for the existing
  converter. Two questions only counsel can answer against the actual
  contract text: (a) does the anti-RE clause reach *file-format
  interoperability* (these clauses usually target the Unity *software*,
  which we never touched), and (b) is there any term restricting tools
  that replicate Unity's bundle-production pipeline. This is **not**
  resolvable from precedent — it depends on the specific Unity license the
  org signed.
- **Recommended action.** Counsel should review the applicable Unity
  EULA/ToS for anti-RE and competing-product clauses. The copyright /
  interoperability angle is comparatively low risk; the contractual angle
  is the one to clear. (The most concrete *redistribution* of Unity IP is
  the TypeTree fixtures — see §4 — which is a separate, narrower issue.)

### 4. TypeTree fixtures — **regenerated, NOT committed** (de-risked)

`encoder/baked-fixtures/typetrees/*.bin` are extracted from real
Unity-built AssetBundles and encode **Unity's engine class schemas** (the
per-class field layouts Unity's serializer emits). To avoid redistributing
Unity engine metadata in version control, these files are **gitignored
and regenerated on demand** rather than committed:

- `.gitignore` excludes `baked-fixtures/typetrees/*.bin`. A clean clone
  ships **no** Unity-derived schema bytes.
- `scripts/regenerate-fixtures.sh` rebuilds them: it discovers a current
  production scene via the registry, downloads a glb + a texture bundle
  (transient, also gitignored), and runs the in-repo, Unity-free
  `extract-typetrees` binary to produce one merged fixture covering every
  class the encoder emits. CI runs this before tests; devs run it before
  the per-class verifiers.
- Tests and verifier tools **skip gracefully** when no fixture is present
  (`type_tree_db::load_fixture_with_class` returns `None`), so
  `cargo test` passes on a clean clone without network — the core logic
  stays covered by hand-built TypeTree round-trip tests that need no
  fixture.
- **Residual question for counsel.** Regeneration still derives the
  schemas from Unity-built bundles (now transiently, at the org's own
  build time, from bundles the org produced and hosts). This is a weaker
  exposure than committing them, but whether deriving/using Unity's
  TypeTree schemas at all is acceptable should still be confirmed against
  the Unity EULA (§3). The mechanism is now: regenerate on demand, commit
  nothing.

### 5. Downloaded test corpus — third-party content, **not committed**

`scripts/download-scenes.sh` downloads Decentraland production scene
bundles (user-generated content owned by scene creators / the DCL DAO)
for round-trip verification. These are **third-party content** and are
**not** committed — `.gitignore` excludes `downloaded-scenes/`, `corpus/`,
and `*.assetbundle`. They are used transiently for testing only and should
never enter version control or be redistributed.

### 6. Third-party Rust dependencies — all permissive

Every direct dependency is under a permissive (non-copyleft) license —
MIT and/or Apache-2.0 — compatible with this repo's Apache-2.0 license.
No copyleft (GPL/LGPL/MPL) dependency is used.

| Crate | License (typical) | Use |
|---|---|---|
| `napi`, `napi-derive` | MIT | Node native-module bindings |
| `tokio` | MIT | async runtime |
| `reqwest` | MIT OR Apache-2.0 | catalyst HTTP client |
| `url` | MIT OR Apache-2.0 | URL handling |
| `httpdate` | MIT OR Apache-2.0 | Retry-After HTTP-date parsing |
| `bytes` | MIT | byte buffers |
| `futures-util` | MIT OR Apache-2.0 | async combinators |
| `lz4_flex` | MIT | UnityFS LZ4 block (de)compression |
| `image` | MIT OR Apache-2.0 | PNG/JPG decode |
| `rand` | MIT OR Apache-2.0 | backoff jitter |
| `thiserror` | MIT OR Apache-2.0 | error types |
| `serde`, `serde_json` | MIT OR Apache-2.0 | (de)serialization |
| `tracing` | MIT | structured logging |

> Run `cargo install cargo-deny && cargo deny check licenses` in CI to
> enforce this (fail the build on any non-allowlisted license). Exact
> per-version license strings should be confirmed from each crate's
> metadata, not this table, before release.

### Summary of recommended actions before release

1. **Provenance audit** of the format modules vs. AssetRipper (GPL-3.0) —
   confirm no copied/translated code (§1). Highest priority given the
   Apache-2.0 license.
2. **Unity EULA/ToS review** for interoperability clauses *and* whether
   deriving Unity TypeTree schemas (now regenerated, not committed — §4)
   is acceptable (§3, §4).
3. **Add `cargo-deny` license enforcement** to CI (§6).
4. ✅ *Done:* TypeTree fixtures are no longer committed — gitignored and
   regenerated via `scripts/regenerate-fixtures.sh` (§4).
5. ✅ *Done:* test corpus stays out of version control — gitignored (§5).
