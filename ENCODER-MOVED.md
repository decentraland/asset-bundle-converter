# The Rust encoder moved to its own repository

The standalone Rust + napi-rs AssetBundle encoder (formerly developed in this
repo's untracked `encoder/` working directory) now lives in its own repository:

- **Repo:** `decentraland/asset-bundle-encoder`
  (<https://github.com/decentraland/asset-bundle-encoder>; local sibling
  checkout: `../asset-bundler`)
- **npm:** `@dcl/asset-bundle-encoder` (the native module this service's
  `consumer-server/src/adapters/asset-bundle-encoder` consumes via npm — there
  is no local source dependency)
- **crates.io:** `dcl-asset-bundle-encoder`

The consumer-server adapter, scene-converter routing, and the encoder env vars
(`ENCODER_ENABLED`, `ENCODER_FALLBACK_TO_UNITY`, `BAKE_VERSION`, …) stay here;
only the encoder's Rust/TypeScript source and its dev/verification tooling
(corpus sweep, fixtures, Explorer-spike harness) moved.
