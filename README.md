
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

## Copyright info

This repository is protected with a standard Apache 2 license. See the terms and conditions in
the [LICENSE](https://github.com/decentraland/unity-renderer/blob/master/LICENSE) file.



