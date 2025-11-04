# AI Agent Context

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
