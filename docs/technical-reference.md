# Technical Reference

This document provides technical details for operators, client developers, and contributors working with the Asset Bundle Converter.

## CDN Filesystem Structure

The service uploads conversion results to an S3 bucket defined by the `CDN_BUCKET` environment variable.

The bucket structure is organized as follows:

```
(root)
├── /manifest          (manifests of converted entities)
│   ├── entityId1.json
│   └── entityId2.json
├── /v4                (files from v4 of the converter)
│   └── ...
└── /v5                (files from v5 of the converter)
    └── ...
```

### Versioning Strategy

- Every asset bundle conversion is bound to a specific version of the converter, set via the `AB_VERSION` environment variable (e.g., `AB_VERSION=v13` in the Dockerfile)
- Versions change when materials change or as a result of upgrading Unity versions
- Version-scoped paths (`/ab/:AB_VERSION/:CID`) allow multiple converter versions to coexist on the same CDN

### Manifests

When each entity is converted, a manifest is generated containing:
- The `AB_VERSION` used for conversion
- A list of converted assets
- Exit code and metadata

Manifests are stored at `/manifest/:entity_id.json` and should have a TTL of 1 hour in edge and CDN cache.

### Compressed Variants

Converted assets are stored in three versions for network optimization:
- `/ab/:AB_VERSION/:CID` - raw asset bundle
- `/ab/:AB_VERSION/:CID.gz` - gzip compressed
- `/ab/:AB_VERSION/:CID.br` - brotli compressed

Converted assets should have a TTL of 1 year in CDN and edge servers.

## Asset Resolution

Clients resolve asset bundles using the manifest to avoid unnecessary 404 roundtrips.

### Manifest Schema

```typescript
type Manifest = {
  version: string      // AB_VERSION used for conversion
  files: string[]      // list of converted file CIDs
  exitCode: number     // conversion exit code (0 = success)
}
```

### Resolution Process

```typescript
const assetBundleCdn = 'https://ab-cdn.decentraland.org'

/**
 * Fetches the manifest for a converted entity
 * @param entityId - EntityID used for the conversion
 * @param assetBundleCdn - Base URL of the asset bundle CDN
 */
async function getSceneManifest(
  entityId: string,
  assetBundleCdn: string
): Promise<Manifest | null> {
  const response = await fetch(`${assetBundleCdn}/manifest/${entityId}.json`)
  if (response.status === 404) return null
  return response.json()
}

/**
 * Resolves the final URL of an asset bundle, or null if not converted
 * @param manifest - Manifest of the converted entity
 * @param cid - Content identifier of the asset
 * @param assetBundleCdn - Base URL of the asset bundle CDN
 */
function resolveAssetBundle(
  manifest: Manifest,
  cid: string,
  assetBundleCdn: string
): string | null {
  if (manifest.files.includes(cid)) {
    if (UNITY_WEBGL) {
      // Brotli compressed for WebGL - browser decompresses in separate thread
      // NOTE: Range requests won't work with .br suffix
      return `${assetBundleCdn}/${manifest.version}/${cid}.br`
    } else {
      // Raw asset bundles for other platforms
      return `${assetBundleCdn}/${manifest.version}/${cid}`
    }
  }
  return null
}
```

### Fallback Behavior

If an asset is not listed in the manifest, clients should fall back directly to the original Catalyst asset without attempting to fetch from the CDN. This avoids waiting for 404 responses and optimizes loading times.

**Example manifest URL:** `https://ab-cdn.decentraland.org/manifest/bafkreie7b36aggssaerg7nvj5s56op5zqyxcqjtkq4q4kjrfhnkljhshgy.json`

## Logs Storage

Conversion logs are stored in a separate S3 bucket for safety, defined by the `LOGS_BUCKET` environment variable.

Log file path structure:
```
logs/:AB_VERSION/:entityId/:DATE_AND_TIME.txt
```

Example: `logs/v13/bafkreie7b36.../2024-01-15T10:30:00.000Z.txt`

## Manual Conversion

To schedule a manual conversion, use the `/queue-task` endpoint with custom authentication:

```bash
curl -XPOST \
  -H 'Authorization: <TMP_SECRET>' \
  -H 'Content-Type: application/json' \
  https://asset-bundle-converter.decentraland.org/queue-task \
  -d '{
    "entityId": "bafkreie7b36...",
    "contentServerUrl": "https://peer.decentraland.org/content"
  }'
```

The job is sent to the queue and consumed by any available worker.

## Deployment

### Continuous Delivery

This repository has continuous delivery to the goerli (decentraland.zone) network.

### Production Deployment

To deploy to production:

1. Select the full commit hash from the version you want to deploy
2. Verify it exists as a tag in [quay.io/repository/decentraland/asset-bundle-converter](https://quay.io/repository/decentraland/asset-bundle-converter?tab=tags)
3. Execute the "Manual Deploy" workflow, selecting the target environment and Docker tag (commit hash)

**Important:** Do not use `latest` as the tag for manual deploys. The deployment pipeline runs on deltas, so deploying `latest` when `latest` is already deployed will detect no changes and skip the deployment. Always use the commit hash.

## Manual Unity Tool Usage

For manual asset bundle conversion using the Unity editor:

1. Initialize and update git submodules:
   ```bash
   git submodule update --init
   git submodule update .
   ```

2. Open the project using Unity 2022.3.12f1

3. Navigate to `Decentraland > Convert Scene` menu

4. Fill in the scene info and press `Start`

5. Once conversion completes, assets appear in the current scene

6. Find converted assets in the `AssetBundles` folder at the repository root
