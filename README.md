# asset-bundle-converter Server

[![Coverage Status](https://coveralls.io/repos/github/decentraland/asset-bundle-converter/badge.svg?branch=main)](https://coveralls.io/github/decentraland/asset-bundle-converter?branch=main)

This server pulls messages from its SQS queue, which receives messages regarding Catalyst deployments (through [Deployments-To-SQS](https://github.com/decentraland/deployments-to-sqs/) bridge) and worlds deployments ([World Content Server](https://github.com/decentraland/worlds-content-server)) in order to generate optimized assets (_including LODs_) to properly render them in world in a performant way.
The resulting artifacts are optimized to be used in the [Unity client](https://github.com/decentraland/unity-explorer).

This server is a bundle of three services:
- **consumer-server:** orchestrator in charge of pulling messages from SQS, executing conversions for each entity, and uploading resulting artifacts to S3
- **scene-lod-entities-manifest-builder:** in charge of generating entity manifests to generate their respective LODs
- **asset-bundle-converter:** Unity process which receives raw textures and generates bundles and LODs from them

**Off-note:** multiple instances of this service are run to support converting bundles for each supported platform (_WebGL, MAC, and Windows_).

## Table of Contents

- [Features](#features)
- [Dependencies & Related Services](#dependencies--related-services)
- [API Documentation](#api-documentation)
- [Database](#database)
  - [Schema](#schema)
  - [Migrations](#migrations)
- [Getting Started](#getting-started)
  - [Prerequisites](#prerequisites)
  - [Installation](#installation)
  - [Configuration](#configuration)
  - [Running the Service](#running-the-service)
- [Testing](#testing)
  - [Running Tests](#running-tests)
  - [Test Structure](#test-structure)
- [Additional Documentation](#additional-documentation)

## Features

- **Asset Bundles Conversion**: Converts entity raw textures to optimized bundles for rendering in Unity projects.
- **Asset Bundles Upload**: Makes resulting optimized bundles available for public consumption by uploading them to an S3 bucket behind a CDN.

## Dependencies & Related Services

This service interacts with the following services (indirectly):

- **[Deployments-To-SQS](https://github.com/decentraland/deployments-to-sqs)**: Source of Catalyst's entities deployments (hooked through SNS subscriptions)
- **[Worlds Content Server](https://github.com/decentraland/worlds-content-server)**: Source of Worlds deployments (hooked through SNS subscription)
- **[LODs Generator](https://github.com/decentraland/lods-generator)**: Source of raw LODs (hooked through SNS subscription)

External dependencies:

- AWS SQS: Queue holding pending conversions
- AWS SNS: Event notifications for resulting conversions
- AWS S3: Media storage for resulting artifacts
- Sentry: Monitoring and observability

<!-- TODO ## API Documentation -->

<!-- The API is fully documented using the [OpenAPI standard](https://swagger.io/specification/). Its schema is located at [docs/openapi.yaml](docs/openapi.yaml). -->

## Getting Started

### Prerequisites

Before running this service, ensure you have the following installed:

- **Node.js**: Version 18.x (LTS recommended)
- **Yarn**: Version 1.22.x or higher
- **Docker**: For containerized deployment (recommended)
- **Unity**: Version 2022.3.12f1 with WebGL/Windows/Mac build targets (only required for local non-Docker development)

### Installation

1. Clone the repository:

```bash
git clone https://github.com/decentraland/asset-bundle-converter.git
cd asset-bundle-converter
```

2. Install dependencies:

```bash
cd consumer-server
yarn install
```

3. Build the project:

```bash
yarn build
```

### Configuration

The service uses environment variables for configuration. Create a .env file in the consumer-server directory containing the environment variables for the service to run. Use the .env.default variables as an example.

### Running the Service

#### Docker-based execution (recommended)

This service is designed to run in a Docker container that includes Unity and all required dependencies. Build and run using:

```bash
# Build for WebGL (default)
docker build -t asset-bundle-converter .

# Build for Windows
docker build --build-arg PLATFORM_TARGET=windows -t asset-bundle-converter-windows .

# Build for Mac
docker build --build-arg PLATFORM_TARGET=mac -t asset-bundle-converter-mac .

# Run the container
docker run --env-file consumer-server/.env asset-bundle-converter
```

#### Local development

For local development without Docker, you need Unity 2022.3.12f1 installed with the appropriate build targets.

1. Ensure your `.env` file has `UNITY_PATH` and `PROJECT_PATH` configured correctly
2. Start the service:

```bash
cd consumer-server
yarn start
```

**Note:** Without `TASK_QUEUE` configured, the service uses an in-memory queue. You can trigger conversions manually via the `/queue-task` endpoint.

## Testing

This service includes comprehensive test coverage with both unit and integration tests.

### Running Tests

All test commands should be run from the `consumer-server/` directory:

```bash
cd consumer-server
```

Run all tests with coverage:

```bash
yarn test
```

Run tests in watch mode:

```bash
yarn test --watch
```

Run only unit tests:

```bash
yarn test test/unit
```

Run only integration tests:

```bash
yarn test test/integration
```

### Test Structure

- **Unit Tests** (`consumer-server/test/unit/`): Test individual components and functions in isolation
- **Integration Tests** (`consumer-server/test/integration/`): Test the complete request/response cycle

For detailed testing guidelines and standards, refer to our [Testing Standards](https://github.com/decentraland/docs/tree/main/development-standards/testing-standards) documentation.

## Additional Documentation

- [Technical Reference](docs/technical-reference.md) - CDN structure, asset resolution, deployment, and manual conversion details
- [AI Agent Context](docs/ai-agent-context.md) - Context for AI-assisted development
