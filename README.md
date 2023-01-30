
# Decentraland Asset Bundle Converter

This is the standalone version of our Asset Bundle Conversion tool that is actually present at the unity-renderer
The intent of this repository is to decouple the conversion tool to have fewer dependencies and more maintainability.

--- 

## Before you start

1. [Contribution Guidelines](.github/CONTRIBUTING.md)
2. [Coding Guidelines](docs/style-guidelines.md)
3. [Code Review Standards](docs/code-review-standards.md)

---

## What does this tool does?

To improve the performance of the WebGL build, in the past, we decided to convert all scenes into Asset Bundles.
So this tool loads every scene asset, loads and re-imports all gltf's to turn them into AssetBundles just for the CI to upload them into the content servers.

## How do I manually run this tool?

- Open this project using `Unity 2021.3.14f1`
- Go to `Decentraland > Convert Scene` menu.
- Fill in the scene info and press `Start`
- Once the conversion is done, you will see the assets loaded in the current scene
- You can find the converted asset at the `AssetBundles` folder located at the root of this repository

---

# The conversion server

This tool is exposed as a standalone project and as a Docker based service. The code of the service lives in the `consumer-server` folder, and runs commands locally calling the project `asset-bundle-converter` of this same repository.

To build the image locally, docker must be used. The recommended command is:

```
docker build -t ab-converter --secret id=ULF,src=./Unity_lic.ulf .
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
├──/v4             (files of the v4 of the conversor)
│  └── ... 
└──/v5             (files of the v5 of the conversor)
   └── ... 
```

- Every asset bundle conversion may be bound to a specific version of the conversor. Versions may change because materials change or as a result of upgrading versions of unity.
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
curl -XPOST -d '{"entityId": "bafyadsaljsdlkas", "contentServerUrl": "https://peer.decentraland.org/content"}' https://asset-bundle-conversor.decentraland.org/queue-task -H 'Authorization: <TOKEN>'
```

---

## Copyright info

This repository is protected with a standard Apache 2 license. See the terms and conditions in
the [LICENSE](https://github.com/decentraland/unity-renderer/blob/master/LICENSE) file.



