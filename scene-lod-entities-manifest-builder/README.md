This LODs Manifest Builder was created based on the experimental [scene-state-server](https://github.com/decentraland/scene-state-server).

Original implementation commits history can be found in [the old prototype PR](https://github.com/decentraland/scene-state-server/pull/30).

# IMPORTANT

To be able to use the tool, `node` version `v18.14.2` is mandatory (newer or older versions may not work).
https://nodejs.org/download/release/v18.14.2/

## What this tool does

Based on a target scene, the manifest builder fetches its main file (`game.js`/`index.js`/`main.crdt`), runs it for some frames with a very basic version of the sdk7 core runtime and outputs a manifest JSON file with the rendereable entities information.

Information gathered:
- Transform component data
- GLTFContainer component data
- MeshRenderer component data
- Material component data

## SDK6 Scenes support

This tool supports targetting SDK6 scenes as it uses the [sdk7-adaption-layer](https://github.com/decentraland/sdk7-adaption-layer/tree/main) when a non SDK7 scene is detected. 

## Running the scene entities lod manifest builder

1. Run `npm i` (on first installation/cloning).

2. Run `npm run build` to build the tool after any modification (or first install).

### For remote target scene

3. Run `npm run start --coords=COORDS-GO-HERE` to run the tool.

Example
```
npm run start --coords=100,100
```

### For local target scene (useful for debugging)

3. Run `npm run start --path="PATH-GOES-HERE"` to run the tool.

Example
```
npm run start --path="../sdk7-scene-template/bin/index.js"
```

## Output

When the manifest builder finishes, the output manifest file will appear as `/output-manifests/${sceneId}-lod-manifest.json`.

By default the manifest builder doesn't overwrite a manifest that has already been built, this is done by checking the existent manifest filename with the target scene id.

Since scene ids change every time a scene is deployed to the catalyst/content-servers, by having the scene id in the manifest file name we can avoid creating a new manifest unnecessarily (e.g. if a service passes through every LAND coordinate and runs this tool, the manifest won't be re-generated for scenes that contain more than 1 LAND).

Overwriting existing manifests can be enabled by passing the `--overwrite` argument e.g. `npm run start --coords=0,0 --overwrite`.

## Alternative workflow with `.env` local file

CLI arguments take priority over reading the `.env` file, so this other workflow only works if there is no CLI argument for that same setting.

### Configuring REMOTE target scene

Create or modify the `.env` file with the var `REMOTE_SCENE_COORDS` specifying the target scene coordiantes. For example:

```
REMOTE_SCENE_COORDS=-129,-77
```

### Configuring LOCAL target scene

Create or modify the `.env` file with the var `LOCAL_SCENE_PATH` specifying the target scene local path. For example:

```
LOCAL_SCENE_PATH=../sdk7-scene-template/bin/index.js
```

The `.env` file can be changed to target a different scene and then `npm run start` is needed again (no need to rebuild if there are no changes to the manifest builder sourcecode).
