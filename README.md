# Decentraland Asset Bundle Converter

This is the standalone version of our Asset Bundle Conversion tool that is actually present at the unity-renderer
The intent of this repository is to decouple the conversion tool to have fewer dependencies and more maintainability.

---

## Before you start

1. [Contribution Guidelines](.github/CONTRIBUTING.md)
2. [Coding Guidelines](docs/style-guidelines.md)
3. [Code Review Standards](docs/code-review-standards.md)

---

## What does this tool do?

To improve the performance of the WebGL build, in the past, we decided to convert all scenes into Asset Bundles.
So this tool loads every scene asset, loads and re-imports all gltf's to turn them into AssetBundles just for the CI to upload them into the content servers.

## How do I manually run this tool?

- Initialize and update the git submodules (`git submodule update --init` and `git submodule update .`)
- Open this project using `Unity 2021.3.20f1`.
- Go to `Decentraland > Convert Scene` menu.
- Fill in the scene info and press `Start`.
- Once the conversion is done, you will see the assets loaded in the current scene.
- You can find the converted asset at the `AssetBundles` folder located at the root of this repository.

---

# The conversion server

This tool is exposed as a standalone project and as a Docker-based service. The code of the service lives in the `consumer-server` folder, and runs commands locally by calling the project `asset-bundle-converter` of this same repository.

To build the image locally, Docker must be used. The recommended command is:

```
docker build -t ab-converter .
```

And to run the server locally, the minimum command is the following:

```
docker run -p 5001:5000 ab-converter
```

After it starts, you should be albe to hit `http://localhost:5001/metrics` to check the server is live.

---

# CDN Filesystem

The service uploads the results of the conversion to a S3 bucket defined in the `CDN_BUCKET` env var.

The structure of the bucket will look like this:

```
(root)
├──/manifest       (manifests of the converted entities)
│  ├── entityId1.json
│  └── entityId2.json
├──/v4             (files of the v4 of the converter)
│  └── ...
└──/v5             (files of the v5 of the converter)
   └── ...
```

- Every asset bundle conversion may be bound to a specific version of the converter. Versions may change because materials change or as a result of upgrading versions of unity.
- This service has an embedded version, which is set via an environment variable (`ENV AB_VERSION v1` in the `Dockerfile`)
- When each entity is converted, a manifest is generated. The manifest contains the AB_VERSION and a list of converted assets. The manifest is stored in the path `/manifest/:entity_id.json`. Manifests should have a TTL of 1 hour in the edge and CDN cache.
- All converted assets are stored in a version-scoped path `/ab/:AB_VERSION/:CID`. Enabling using the same CDN different versions at a time. Converted assets should have a TTL of 1year in the CDN and edge servers.
- Converted assets are stored in three versions: `/ab/:AB_VERSION/:CID`, `/ab/:AB_VERSION/:CID.gz` and `/ab/:AB_VERSION/:CID.br` being to enable network optimizations.

# Logs

Logs of conversions are stored in a different bucket for safety reasons, the bucket is defined with the environment variable `LOGS_BUCKET`.

The logs for each conversion are stored in the path `logs/:AB_VERSION/:entityId/:DATE_AND_TIME.log`

# Scheduling a manual conversion

To schedule a manual conversion, there is an special with custom authentication at `/queue-task`. It sends a job to the queue, the job will be consumed by any available worker.

```
curl -XPOST -H 'Authorization: <TOKEN>' https://asset-bundle-converter.decentraland.org/queue-task -d '{"entityId": "bafyadsaljsdlkas", "contentServerUrl": "https://peer.decentraland.org/content"}'
```

# Using the new asset bundles

This converter leverages versioning for the assets, the version is changed by the `AB_VERSION` env var in the Dockerfile.

This differs from the previous asset bundles in an impactful way: not all assets are stored at root level anymore. This is due to incompatibilities across versions of the shaders/materials and unity itself.

Prior to this converter, the renderer used to look for the asset bundles of all models and textures, and fallback to the original asset if a 404 was returned.

Now the assets need to be resolved based on a manifest including the list of converted files. If the files are not in the list, we can fallback directly to the original asset without waiting for the 404 and thus, optimizing network roundtrips and loading times.

Here is some pseudocode to illustrate the asset resolution process for an entity:

```typescript
// this is the manifest file, it is uploaded after the entire entity was uploaded.
type Manifest = {
  version: string
  files: string[] // list of converted files
  exitCode: number // not used
}

const assetBundleCdn = 'https://ab-cdn.decentraland.zone' // .org

/**
 * This function returns the manifest of a converted scene
 * @param entityId - EntityID used for the conversion
 * @param assetBundleCdn - baseUrl of the asset bundle CDN.
 */
async function getSceneManifest(entityId: string, assetBundleCdn: string): Manifest | null = {
  const manifest = await fetch(`${assetBundleCdn}/manifest/${entityId}.json`)
  if (manifest.statusCode == 404) return null
  return manifest.json()
}

/**
 *  This function resolves the final URL of the asset bundle or returns null if it was not converted
 * @param manifest - Manifest of the converted entity
 * @param cid - content identifier of the asset being converted
 * @param assetBundleCdn - baseUrl of the asset bundle CDN.
 */
async function resolveAssetBundle(
  manifest: Manifest,
  cid: string,
  assetBundleCdn: string
): string | null {
  if (manifest.files.includes(cid)) {
    if (UNITY_WEBGL)
      // brotli compressed asset bundles for WebGL, the browser will
      // uncompress and cache this asset in a different thread
      // NOTICE: if the asset bundles support range requests, they
      //         won't work with the .br postfix!
      return `${assetBundleCdn}/${manifest.version}/${cid}.br`
    else
      // raw asset bundles for the rest of the platforms
      return `${assetBundleCdn}/${manifest.version}/${cid}`
  }
  return null
}
```

> As an exercise for the reader, here is a URL to resolve assets manually: `https://ab-cdn.decentraland.zone/manifest/bafkreie7b36aggssaerg7nvj5s56op5zqyxcqjtkq4q4kjrfhnkljhshgy.json`

# Deploying

This repository has continuous delivery to the goerli (decentraland.zone) network.

To deploy to production, you must first select the full commit hash from the version you whish to deploy. Then check it exists as a tag in https://quay.io/repository/decentraland/asset-bundle-converter?tab=tags and lastly execute the workflow "Manual Deploy" selecting the target environment and the docker tag (commit hash).

NOTICE: Please do not use `latest` as tag for the "Manual deploy", the pipeline of deployments runs on deltas, and if there was a "latest" and now we try to deploy "latest", it will detect no changes and finish without deploying. Always use the commit hash.

---

## Copyright info

This repository is protected with a standard Apache 2 license. See the terms and conditions in
the [LICENSE](https://github.com/decentraland/unity-renderer/blob/master/LICENSE) file.

## AI Agent Context

**Service Purpose:** Converts Decentraland scene assets (GLTF models, textures) into optimized Unity Asset Bundles for improved WebGL performance. The service monitors deployment events and processes entities (scenes, wearables, emotes) by re-importing GLTF files in Unity and packaging them into versioned, compressed Asset Bundles stored on CDN.

**Key Capabilities:**

- **Unity-based Conversion**: Uses Unity 2021.3.20f1 to load and re-import GLTF models, applying optimizations and generating Asset Bundles
- **Multi-version Support**: Generates versioned Asset Bundles (v4, v5+) to handle shader/material changes and Unity upgrades
- **Compression Formats**: Produces raw, gzip (.gz), and brotli (.br) compressed variants for network optimization
- **Manifest Generation**: Creates JSON manifests listing converted files with version metadata
- **Queue Processing**: Consumes deployment events from AWS SQS (`ab-conversion-queue`) triggered by deployments-to-sqs service
- **CDN Upload**: Stores converted assets and manifests in S3 bucket with version-scoped paths
- **Logging**: Archives conversion logs to separate S3 bucket for debugging and audit

**Communication Pattern:** 
- Event-driven via AWS SQS (consumes deployment events)
- Synchronous HTTP API (manual conversion requests via `/queue-task` endpoint)
- Publishes `AssetBundleConversionFinished` events to SNS upon completion

**Technology Stack:**

- **Conversion Engine**: Unity 2021.3.20f1 (C# editor scripts)
- **Service Runtime**: Node.js (consumer-server)
- **Language**: TypeScript (service), C# (Unity conversion)
- **HTTP Framework**: @well-known-components/http-server
- **Component Architecture**: @well-known-components (logger, metrics, http-server)

**External Dependencies:**

- Queue: AWS SQS (`ab-conversion-queue` subscribed to deployments SNS topic)
- Storage: AWS S3 (CDN bucket for assets/manifests, logs bucket for conversion logs)
- Event Bus: AWS SNS (publishes conversion completion events)
- Content Server: Catalyst (fetches original entity content for conversion)
- CDN: S3-backed CDN for serving optimized Asset Bundles to clients

**Conversion Workflow:**

1. Deployment event received from SQS queue
2. Entity content fetched from Catalyst
3. Unity conversion process initiated (GLTF re-import, Asset Bundle generation)
4. Compressed variants created (.gz, .br) for network optimization
5. Manifest JSON generated with version and file list
6. Assets and manifest uploaded to versioned S3 paths
7. Conversion log archived to logs bucket
8. Completion event published to SNS (consumed by Asset Bundle Registry)

**Project Structure:**

- `asset-bundle-converter/`: Unity project with conversion scripts, GLTF loaders, Asset Bundle builders
- `consumer-server/`: Node.js service for queue consumption, conversion orchestration, CDN upload
- `Dockerfile`: Containerizes Unity conversion environment

**Versioning Strategy:**

- Asset Bundles versioned via `AB_VERSION` environment variable
- Enables multiple converter versions to coexist (handles Unity/shaders/material changes)
- Clients resolve assets via manifest to determine which versioned paths to use
- Fallback to original Catalyst assets if not in manifest (avoids 404 roundtrips)



