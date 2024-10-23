import { Entity } from '@dcl/schemas'
import * as fs from 'fs';
import * as path from 'path';
import fetch from 'node-fetch';  // Assuming you're using the node-fetch package
async function getActiveEntity(pointers: string, sourceServer: string): Promise<Entity> {
    const url = `${sourceServer}/entities/active`
    const res = await fetch(url, {
        method: 'post',
        body: JSON.stringify({ pointers }),
        headers: { 'content-type': 'application/json' }
    })

    const response = await res.text()

    if (!res.ok) {
        throw new Error('Error fetching list of active entities: ' + response)
    }

    return JSON.parse(response)[0]
}


async function getManifestFiles(entityID: string, buildTarget: string): Promise<any | null> {
    const url = `https://ab-cdn.decentraland.org/manifest/${entityID}_${buildTarget}.json`;

    const res = await fetch(url);
    const response = await res.json();

    if (!res.ok) {
        throw new Error('Error fetching manifest: ' + JSON.stringify(response));
    }

    if (response.exitCode === 0) {
        return response;  // Return the full manifest as regular JSON
    } else {
        console.error(`Error: exitCode is ${response.exitCode}`);
        return null;
    }
}

async function getLastEntityIdByBase(base: string): Promise<Entity | null> {
    const url = `https://peer-ap1.decentraland.org/content/pointer-changes?entityType=scene`;

    const res = await fetch(url);
    const response = await res.json();

    if (!res.ok) {
        throw new Error('Error fetching pointer changes: ' + JSON.stringify(response));
    }

    let lastEntityId: string | null = null;

    // Iterate through the deltas array
    for (const delta of response.deltas) {
        const deltaBase = delta.metadata.scene?.base;
        if (deltaBase && deltaBase === base) {
            // Update the lastEntityId with the latest match
            lastEntityId = delta.entityId;
        }
    }

    // Return the last matching entityId, or null if none are found
    return lastEntityId;
}

// Extension lists
const bufferExtensions = [".bin"];
const gltfExtensions = [".glb", ".gltf"];
const textureExtensions = [".jpg", ".png", ".jpeg", ".tga", ".gif", ".bmp", ".psd", ".tiff", ".iff", ".ktx"];

// Helper function to check if the file has a valid extension
function hasValidExtension(file: string): boolean {
    const extension = file.substring(file.lastIndexOf('.')).toLowerCase();
    return (
        bufferExtensions.includes(extension) ||
        gltfExtensions.includes(extension) ||
        textureExtensions.includes(extension)
    );
}

// Function to extract hashes from the entity JSON based on valid extensions
function extractValidHashesFromEntity(content: { file: string, hash: string }[]): string[] {
    return content
        .filter(entry => hasValidExtension(entry.file))  // Only include entries with valid extensions
        .map(entry => entry.hash);  // Extract the hash
}

// Helper function to check if a hash exists in the manifest
function isHashInManifest(hash: string, manifestFiles: string[]): boolean {
    // Check if any manifest file starts with the same hash (ignoring suffixes like _windows)
    return manifestFiles.some(manifestFile => manifestFile.startsWith(hash));
}

// Function to check if all filtered content hashes are in the manifest
function AreAllContentHashesInManifest(content: { file: string, hash: string }[], manifestFiles: string[]): boolean {
    const validHashes = extractValidHashesFromEntity(content);
    return validHashes.every(hash => isHashInManifest(hash, manifestFiles));
}

async function downloadFilesFromManifestSuccesfully(manifest: any, outputFolder: string): Promise<boolean> {
    const baseUrl = `https://ab-cdn.decentraland.org/${manifest.version}/`;

    for (const file of manifest.files) {
        const fileUrl = `${baseUrl}${file}`;
        console.log(`Downloading: ${fileUrl}`);

        try {
            const res = await fetch(fileUrl);

            if (!res.ok) {
                throw new Error(`Failed to download file: ${fileUrl}`);
            }

            const buffer = await res.buffer(); // Download as buffer
            const outputPath = path.join(outputFolder, file); // Path to save the file

            // Write the file to the output folder
            fs.writeFileSync(outputPath, buffer);

            console.log(`Downloaded and saved: ${outputPath}`);
        } catch (error) {
            console.error(`Error downloading file ${file}:`, error);
            return false
        }
    }
    return true
}


export async function HasContentChange(entityId : string, contentServerUrl : string, buildTarget : string, outputFolder : string) : Promise<boolean>{
    const entity = await getActiveEntity(entityId, contentServerUrl)
    if (entity.type === 'scene') {
        const previousHash = await getLastEntityIdByBase(entityId);
        if (previousHash != null) {
            const manifest = await getManifestFiles(previousHash, buildTarget)
            if(manifest != null) {
                const doesEntityMatchHashes = AreAllContentHashesInManifest(entity.content, manifest.files);
                if(doesEntityMatchHashes){
                    const allFilesDownloadSuccesfully = await downloadFilesFromManifestSuccesfully(manifest, outputFolder)
                    //If all files download successfully, content has not changed
                    return !allFilesDownloadSuccesfully
                }
            }
        }
    }
    return true
}
