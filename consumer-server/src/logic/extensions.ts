// Shared file-extension classification. Split out of `has-content-changed-task.ts`
// because that module is scheduled for deletion (see CLAUDE.md — the legacy
// scene-level short-circuit is superseded by the per-asset reuse path), and
// nothing else should depend on a dying module.
//
// These lists classify entries in a Decentraland entity's `content` array —
// the scene's source files, not Unity's built bundles — so they describe
// possible INPUTS to the converter, not outputs.

export const bufferExtensions = ['.bin']

export const gltfExtensions = ['.glb', '.gltf']

export const textureExtensions = ['.jpg', '.png', '.jpeg', '.tga', '.gif', '.bmp', '.psd', '.tiff', '.iff', '.ktx']

/** True if `file` has an extension that participates in the asset-bundle
 * pipeline at all (either becomes a bundle itself or is inlined as a
 * dependency of a bundle). Used by the legacy scene-level short-circuit
 * (`hasContentChange`). New code should use the narrower
 * `PROBE_EXTENSIONS` / `GLB_DEP_EXTENSIONS` sets defined in `asset-reuse.ts`
 * instead. */
export function hasValidExtension(file: string): boolean {
  const extension = file.substring(file.lastIndexOf('.')).toLowerCase()
  return (
    bufferExtensions.includes(extension) || gltfExtensions.includes(extension) || textureExtensions.includes(extension)
  )
}
