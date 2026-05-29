/**
 * Unity-free bake driver for the Rust encoder.
 *
 * Produces the three artifacts the encoder loads from S3 at startup
 * (`shader-guids.json`, `bake-info.json`, `typetrees.bin`) WITHOUT
 * requiring a Unity install, a Unity license, or running the Unity
 * editor. Runs on any Linux/macOS machine with Node.js — suitable for
 * CI.
 *
 * What replaces Unity:
 *   * **Shader GUIDs**: extracted from `*.shader.meta` YAML files
 *     checked into the Explorer's shader package. Unity wrote them
 *     once when the assets were first imported; they're stable across
 *     subsequent imports and are git-tracked.
 *   * **Shader names**: parsed from the first `Shader "..."` line of
 *     each `.shader` file.
 *   * **Shader pathIDs**: hardcoded to Unity's `.shader` convention
 *     (`4800000`). Override per-shader via the SHADER_PATH_ID_OVERRIDES
 *     map below if a particular shader has a non-conventional file-ID
 *     (verifiable by inspecting the .meta's `mainObjectFileID` field if
 *     it exists, or by decompiling a Unity-built bundle that references
 *     the shader).
 *   * **TypeTrees**: vendored as a pre-extracted JSON fixture in
 *     `encoder/baked-fixtures/typetrees/{unity_version}.bin`. The
 *     fixture comes from a one-time external extraction (UnityPy or
 *     AssetRipper run against an existing ab-cdn bundle) — see
 *     `encoder/baked-fixtures/README.md`. Re-extract only when the
 *     Explorer upgrades its Unity version.
 *
 * Usage:
 *   yarn bake \
 *     --explorer-repo /Users/me/repos/unity-explorer \
 *     --bake-version 2026-05-26-abc123 \
 *     --output ./output-bake \
 *     [--targets windows,mac,webgl]
 *
 * Or via env vars (CI):
 *   EXPLORER_REPO=... BAKE_VERSION=... yarn bake
 *
 * Upload step (manual, follow-on):
 *   aws s3 cp ./output-bake/ s3://${AB_BAKE_BUCKET}/${BAKE_VERSION}/ --recursive
 */

import * as fs from 'fs'
import * as path from 'path'

// ---------------------------------------------------------------------------
// Configuration — light enough to inline.
// ---------------------------------------------------------------------------

// The DCL shared dependencies package lives under the Explorer repo at
// `Explorer/Library/PackageCache/com.decentraland.unity-shared-dependencies@<commit-hash>/`.
// `resolveShaderPackageRoot` finds it by prefix-matching the cache dir;
// the trailing `@<hash>` is Unity's Package Manager folder naming and
// changes whenever the shared-deps repo bumps.

const SHADER_PACKAGE_PREFIX = 'com.decentraland.unity-shared-dependencies@'
const SHADER_SUBDIR = 'Runtime/Shaders'

/** Unity's TypeID for Shader assets in serialised PPtr external refs. */
const SHADER_ASSET_TYPE = 3

/**
 * Unity's conventional local file identifier for the main Shader
 * sub-asset inside a `.shader` file. Stable across every Unity version
 * we've inspected; override here if a future shader doesn't follow the
 * convention.
 */
const DEFAULT_SHADER_PATH_ID = 4_800_000

/** Per-shader path-ID overrides. Empty in the common case. */
const SHADER_PATH_ID_OVERRIDES: Record<string, number> = {}

const TARGETS = ['windows', 'mac', 'webgl'] as const
type Target = (typeof TARGETS)[number]

// ---------------------------------------------------------------------------
// Argument parsing — small enough to skip a CLI library.
// ---------------------------------------------------------------------------

type Args = {
  explorerRepo: string
  bakeVersion: string
  output: string
  targets: ReadonlyArray<Target>
  typetreesFixture?: string
}

function parseArgs(argv: ReadonlyArray<string>): Args {
  const flags = new Map<string, string>()
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]
    if (flag.startsWith('--') && i + 1 < argv.length) {
      flags.set(flag.slice(2), argv[i + 1])
      i++
    }
  }
  const explorerRepo = flags.get('explorer-repo') ?? process.env.EXPLORER_REPO ?? ''
  const bakeVersion = flags.get('bake-version') ?? process.env.BAKE_VERSION ?? ''
  const output = flags.get('output') ?? process.env.BAKE_OUTPUT ?? './output-bake'
  const targetsRaw = (flags.get('targets') ?? process.env.BAKE_TARGETS ?? 'windows,mac,webgl').toLowerCase()
  // Resolve to the encoder/baked-fixtures default; allow override for CI
  // that vendors a different snapshot.
  const typetreesFixture = flags.get('typetrees-fixture') ?? process.env.BAKE_TYPETREES_FIXTURE ?? undefined

  if (!explorerRepo) {
    throw new Error('--explorer-repo (or EXPLORER_REPO) is required')
  }
  if (!bakeVersion) {
    throw new Error('--bake-version (or BAKE_VERSION) is required')
  }
  const targets = targetsRaw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  for (const t of targets) {
    if (!TARGETS.includes(t as Target)) {
      throw new Error(`Unknown target "${t}" — supported: ${TARGETS.join(', ')}`)
    }
  }
  return {
    explorerRepo,
    bakeVersion,
    output,
    targets: targets as ReadonlyArray<Target>,
    typetreesFixture
  }
}

// ---------------------------------------------------------------------------
// Shader discovery — walk the shader package, parse .shader + .shader.meta.
// ---------------------------------------------------------------------------

type ShaderEntry = {
  guid: string
  pathId: number
  type: number
}

function resolveShaderPackageRoot(explorerRepo: string): string {
  // Resolve EXPLORER_SHADER_PACKAGE_GLOB by reading the Library/PackageCache
  // directory and picking the entry whose name starts with the prefix.
  // Simpler than pulling in glob just for one wildcard.
  const cacheDir = path.join(explorerRepo, 'Explorer/Library/PackageCache')
  if (!fs.existsSync(cacheDir)) {
    throw new Error(
      `Expected Unity PackageCache directory at ${cacheDir}. ` +
        `Pass --explorer-repo pointing at the unity-explorer repo root.`
    )
  }
  const entries = fs.readdirSync(cacheDir)
  const match = entries.find((e) => e.startsWith(SHADER_PACKAGE_PREFIX))
  if (!match) {
    throw new Error(
      `No shader package found under ${cacheDir} (looked for prefix "${SHADER_PACKAGE_PREFIX}"). ` +
        `Has the Explorer's Package Manager populated the cache?`
    )
  }
  return path.join(cacheDir, match, SHADER_SUBDIR)
}

/**
 * Walk a directory recursively and yield every file whose path matches
 * a predicate. Inlined rather than importing a globber because the
 * matching is trivially recursive and we want to avoid a runtime dep.
 */
function walkSync(root: string, predicate: (filePath: string) => boolean): string[] {
  if (!fs.existsSync(root)) return []
  const out: string[] = []
  const stack: string[] = [root]
  while (stack.length > 0) {
    const dir = stack.pop()!
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        stack.push(full)
      } else if (predicate(full)) {
        out.push(full)
      }
    }
  }
  return out
}

/**
 * Extract the shader name from the first line of a .shader file.
 * Tolerates UTF-8 BOM (some DCL shaders have one — e.g. URP/Unlit.shader)
 * and matches the same `Shader "..."` form Unity expects.
 */
function parseShaderName(shaderPath: string): string {
  const raw = fs.readFileSync(shaderPath, 'utf8')
  // Strip UTF-8 BOM (U+FEFF) if present — fs.readFileSync('utf8')
  // preserves it.
  const text = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw
  const match = text.match(/^\s*Shader\s+"([^"]+)"/m)
  if (!match) {
    throw new Error(`Could not find Shader "..." directive in ${shaderPath}`)
  }
  return match[1]
}

/**
 * Extract the GUID from a Unity .meta YAML file. .meta files always
 * have a top-level `guid: <32-hex>` line — we parse it directly rather
 * than pulling in a YAML library.
 */
function parseGuidFromMeta(metaPath: string): string {
  const text = fs.readFileSync(metaPath, 'utf8')
  const match = text.match(/^guid:\s*([a-f0-9]{32})\s*$/m)
  if (!match) {
    throw new Error(`No guid: line in ${metaPath}`)
  }
  return match[1]
}

function discoverShaders(shaderRoot: string): Record<string, ShaderEntry> {
  const shaderFiles = walkSync(shaderRoot, (p) => p.endsWith('.shader'))
  if (shaderFiles.length === 0) {
    throw new Error(`No .shader files found under ${shaderRoot}`)
  }
  const out: Record<string, ShaderEntry> = {}
  for (const shaderPath of shaderFiles) {
    const metaPath = `${shaderPath}.meta`
    if (!fs.existsSync(metaPath)) {
      console.warn(`[bake] WARN: ${shaderPath} has no .meta sibling — skipping.`)
      continue
    }
    const name = parseShaderName(shaderPath)
    const guid = parseGuidFromMeta(metaPath)
    const pathId = SHADER_PATH_ID_OVERRIDES[name] ?? DEFAULT_SHADER_PATH_ID
    out[name] = { guid, pathId, type: SHADER_ASSET_TYPE }
  }
  // Sort keys so output is byte-stable across runs absent shader
  // changes — bake artifacts then diff cleanly between BAKE_VERSIONs.
  return Object.fromEntries(
    Object.keys(out)
      .sort()
      .map((k) => [k, out[k]])
  )
}

// ---------------------------------------------------------------------------
// TypeTree fixture — vendored at encoder/baked-fixtures, one per Unity
// version. Bake driver copies the right one into each target output.
// ---------------------------------------------------------------------------

const DEFAULT_TYPETREES_FIXTURE = path.resolve(__dirname, '../../encoder/baked-fixtures/typetrees/2021.3.20f1.bin')

function loadTypeTrees(fixturePathOverride: string | undefined): Buffer {
  const fixturePath = fixturePathOverride ?? DEFAULT_TYPETREES_FIXTURE
  if (fs.existsSync(fixturePath)) {
    return fs.readFileSync(fixturePath)
  }
  // No fixture yet — emit a 1-byte stub. The encoder accepts this and
  // starts; encode() then fails at the serialisation step (caught by
  // ENCODER_FALLBACK_TO_UNITY during rollout). Mirrors the previous
  // Unity-editor-script behaviour.
  console.warn(
    `[bake] WARN: no TypeTrees fixture at ${fixturePath}. ` +
      `Writing a 1-byte stub. See encoder/baked-fixtures/README.md ` +
      `for the one-time extraction procedure.`
  )
  return Buffer.from([0x00])
}

// ---------------------------------------------------------------------------
// Output writers.
// ---------------------------------------------------------------------------

function writeTarget(
  outputRoot: string,
  target: Target,
  shaders: Record<string, ShaderEntry>,
  typeTrees: Buffer,
  bakeVersion: string,
  unityVersion: string
): void {
  const dir = path.join(outputRoot, target)
  fs.mkdirSync(dir, { recursive: true })

  // shader-guids.json — keys sorted by discoverShaders for stability.
  // Two-space indent matches typical JSON style; doesn't affect the
  // encoder, which parses with serde_json.
  fs.writeFileSync(path.join(dir, 'shader-guids.json'), JSON.stringify(shaders, null, 2) + '\n')

  // bake-info.json — diagnostic only; surfaced in the encoder's
  // startup log line.
  const bakeInfo = {
    unityVersion,
    bakeVersion,
    bakeDate: new Date().toISOString()
  }
  fs.writeFileSync(path.join(dir, 'bake-info.json'), JSON.stringify(bakeInfo, null, 2) + '\n')

  // typetrees.bin — same fixture across targets for now (TypeTree
  // layout depends on Unity version, not on the build target). If we
  // ever need per-target type trees (unlikely — they're class
  // schemas, not platform-specific), the fixture path can branch on
  // target here.
  fs.writeFileSync(path.join(dir, 'typetrees.bin'), typeTrees)

  console.log(
    `[bake]   ${target}: wrote shader-guids.json (${Object.keys(shaders).length} shaders), ` +
      `bake-info.json, typetrees.bin (${typeTrees.byteLength} bytes)`
  )
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

function main() {
  const args = parseArgs(process.argv.slice(2))

  console.log(`[bake] BAKE_VERSION=${args.bakeVersion}`)
  console.log(`[bake] explorer repo: ${args.explorerRepo}`)
  console.log(`[bake] targets: ${args.targets.join(', ')}`)
  console.log(`[bake] output: ${args.output}`)

  const shaderRoot = resolveShaderPackageRoot(args.explorerRepo)
  console.log(`[bake] shader package: ${shaderRoot}`)

  const shaders = discoverShaders(shaderRoot)
  console.log(`[bake] discovered ${Object.keys(shaders).length} shaders:`)
  for (const [name, entry] of Object.entries(shaders)) {
    console.log(`[bake]   ${name} → guid=${entry.guid} pathId=${entry.pathId}`)
  }

  const typeTrees = loadTypeTrees(args.typetreesFixture)

  // Unity version stays pinned to what the Explorer's currently built
  // against (2021.3.20f1 per the converter's ProjectSettings). When
  // Explorer upgrades Unity, update this string AND re-extract the
  // typetrees fixture.
  const unityVersion = '2021.3.20f1'

  for (const target of args.targets) {
    writeTarget(args.output, target, shaders, typeTrees, args.bakeVersion, unityVersion)
  }

  console.log(`[bake] Done. Upload with:`)
  console.log(`  aws s3 cp ${args.output}/ s3://\${AB_BAKE_BUCKET}/${args.bakeVersion}/ --recursive`)
}

if (require.main === module) {
  try {
    main()
  } catch (err: any) {
    console.error(`[bake] FAILED: ${err.message}`)
    process.exitCode = 1
  }
}

// Exported for unit tests.
export { discoverShaders, parseShaderName, parseGuidFromMeta, resolveShaderPackageRoot }
