import { Entity } from '@dcl/schemas'
import * as fs from 'fs'
import * as path from 'path'
import fetch from 'node-fetch'
import {ILoggerComponent} from "@well-known-components/interfaces"; // Assuming you're using the node-fetch package
async function getActiveEntity(ids: string, contentServer: string): Promise<Entity> {
  const url = `${contentServer}/entities/active`

  const res = await fetch(url, {
    method: 'post',
    body: JSON.stringify({ ids: [ids] }),
    headers: { 'content-type': 'application/json' }
  })

  const response = await res.text()

  if (!res.ok) {
    throw new Error('Error fetching list of active entities: ' + response)
  }

  return JSON.parse(response)[0]
}

async function getManifestFiles(entityID: string, buildTarget: string): Promise<any | null> {
  const url = `https://ab-cdn.decentraland.org/manifest/${entityID}_${buildTarget}.json`

  const res = await fetch(url)
  const response = await res.json()

  if (!res.ok) {
    throw new Error('Error fetching manifest: ' + JSON.stringify(response))
  }

  if (response.exitCode === 0) {
    return response
  } else {
    console.error(`Error: exitCode is ${response.exitCode}`)
    return null
  }
}

async function getLastEntityIdByBase(base: string, contentServer: string): Promise<string | null> {
  const url = `${contentServer}/pointer-changes?entityType=scene&sortingField=localTimestamp`

  const res = await fetch(url)
  const response = await res.json()

  if (!res.ok) {
    throw new Error('Error fetching pointer changes: ' + JSON.stringify(response))
  }

  // Iterate through the deltas array to find the first matching base, since order is DESC in the endpoint
  for (const delta of response.deltas) {
    const deltaBase = delta.metadata.scene?.base
    if (deltaBase && deltaBase === base) {
      return delta.entityId
    }
  }

  // Return null if no match is found
  return null
}

// Extension lists
const bufferExtensions = ['.bin']
const gltfExtensions = ['.glb', '.gltf']
const textureExtensions = ['.jpg', '.png', '.jpeg', '.tga', '.gif', '.bmp', '.psd', '.tiff', '.iff', '.ktx']

// Helper function to check if the file has a valid extension
function hasValidExtension(file: string): boolean {
  const extension = file.substring(file.lastIndexOf('.')).toLowerCase()
  return (
    bufferExtensions.includes(extension) || gltfExtensions.includes(extension) || textureExtensions.includes(extension)
  )
}

// Function to extract hashes from the entity JSON based on valid extensions
function extractValidHashesFromEntity(content: { file: string; hash: string }[]): string[] {
  return content
    .filter((entry) => hasValidExtension(entry.file)) // Only include entries with valid extensions
    .map((entry) => entry.hash) // Extract the hash
}

// Helper function to check if a hash exists in the manifest
function isHashInManifest(hash: string, manifestFiles: string[]): boolean {
  // Check if any manifest file starts with the same hash (ignoring suffixes like _windows)
  return manifestFiles.some((manifestFile) => manifestFile.startsWith(hash))
}

// Function to check if all filtered content hashes are in the manifest
function AreAllContentHashesInManifest(hashes: string[], manifestFiles: string[]): boolean {
  return hashes.every((hash) => isHashInManifest(hash, manifestFiles))
}

async function downloadFilesFromManifestSuccesfully(
  hashesToDownload: string[],
  version: string,
  buildTarget: string,
  previousHash: string,
  outputFolder: string
): Promise<boolean> {
  const baseUrl = `https://ab-cdn.decentraland.org/${version}/${previousHash}/`

  for (const file of hashesToDownload) {
    const fileToDownload = `${file}_${buildTarget}`
    const fileUrl = `${baseUrl}${fileToDownload}`
    try {
      const res = await fetch(fileUrl)

      if (!res.ok) {
        throw new Error(`Failed to download file: ${fileUrl}`)
      }

      const buffer = await res.buffer() // Download as buffer
      const outputPath = path.join(outputFolder, fileToDownload) // Path to save the file

      // Write the file to the output folder
      fs.writeFileSync(outputPath, buffer)

      console.log(`Downloaded and saved: ${outputPath}`)
    } catch (error) {
      console.error(`Error downloading file ${file}:`, error)
      return false
    }
  }
  return true
}

// Helper function to delete all files in the output folder
async function DeleteFilesInOutputFolder(outputFolder: string): Promise<void> {
  if (fs.existsSync(outputFolder)) {
    const files = fs.readdirSync(outputFolder)

    for (const file of files) {
      const filePath = path.join(outputFolder, file)
      fs.unlinkSync(filePath) // Delete each file
    }

    console.log(`Deleted all files in ${outputFolder}`)
  }
}

//Checks if the new content is all built in a previous version. If all the content is present, then it wont convert,
//it will just download it from the old one
//Note: ALL OF THE CONTENT NEEDS TO BE PRESENT. Just one change forces a reconversion
export async function hasContentChange(
  entityId: string,
  contentServerUrl: string,
  buildTarget: string,
  outputFolder: string,
  logger : ILoggerComponent.ILogger
): Promise<boolean> {
  const entity = await getActiveEntity(entityId, contentServerUrl)
  if (entity.type === 'scene') {
    logger.info(`HasContentChanged: Entity ${entityId} is a scene`)
    const previousHash = await getLastEntityIdByBase(entity.metadata.scene.base, contentServerUrl)
    if (previousHash !== null) {
      logger.info(`HasContentChanged: Previous hash is ${previousHash}`)
      const manifest = await getManifestFiles(previousHash, buildTarget)
      if (manifest !== null) {
        logger.info(`HasContentChanged: Manifest exists for hash ${previousHash}`)
        const hashes = extractValidHashesFromEntity(entity.content)
        const doesEntityMatchHashes = AreAllContentHashesInManifest(hashes, manifest.files)
        if (doesEntityMatchHashes) {
          logger.info(`HasContentChanged: All entities contained in old manifest`)
          const allFilesDownloadSuccesfully = await downloadFilesFromManifestSuccesfully(
            hashes,
            manifest.version,
            buildTarget,
            previousHash,
            outputFolder
          )
          //If all files download successfully, content has not changed
          if (allFilesDownloadSuccesfully) {
            return false
          } else {
            logger.info(`HasContentChanged: Some downloads failed`)
            //In case we downloaded some file, remove the corrupt state
            await DeleteFilesInOutputFolder(outputFolder)
          }
        }
      }
    }
  }
  return true
}
