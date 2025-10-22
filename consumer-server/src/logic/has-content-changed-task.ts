import * as fs from 'fs'
import * as path from 'path'
import fetch from 'node-fetch'
import { ILoggerComponent } from '@well-known-components/interfaces'
import { getActiveEntity } from './fetch-entity-by-pointer'

async function getManifestFiles(
  entityID: string,
  buildTarget: string,
  env: string,
  logger: ILoggerComponent.ILogger
): Promise<any | null> {
  const url = `https://ab-cdn.decentraland.${env}/manifest/${entityID}_${buildTarget}.json?no-cache=123`

  const res = await fetch(url)
  const response = await res.json()

  if (!res.ok) {
    throw new Error('Error fetching manifest: ' + JSON.stringify(response))
  }

  if (response.exitCode === 0) {
    return response
  } else {
    logger.error(`Error: exitCode is ${response.exitCode}`)
    return null
  }
}

async function getLastEntityIdByBase(
  currentEntityId: string,
  base: string,
  contentServer: string
): Promise<string | null> {
  const url = `${contentServer}/pointer-changes?entityType=scene&sortingField=localTimestamp`

  const res = await fetch(url)
  const response = await res.json()

  if (!res.ok) {
    throw new Error('Error fetching pointer changes: ' + JSON.stringify(response))
  }

  // Iterate through the deltas array to find the first matching base, since order is DESC in the endpoint
  for (const delta of response.deltas) {
    const deltaBase = delta.metadata.scene?.base
    if (deltaBase && deltaBase === base && delta.entityId !== currentEntityId) {
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
  outputFolder: string,
  env: string,
  logger: ILoggerComponent.ILogger
): Promise<boolean> {
  fs.mkdirSync(outputFolder, { recursive: true })

  const baseUrl = `https://ab-cdn.decentraland.${env}/${version}/${previousHash}/`

  for (const file of hashesToDownload) {
    const fileToDownload = `${file}_${buildTarget}`
    const fileUrl = `${baseUrl}${fileToDownload}`
    try {
      const res = await fetch(fileUrl)

      if (!res.ok) {
        throw new Error(`HasContentChanged: Failed to download file: ${fileUrl}`)
      }

      const buffer = await res.buffer() // Download as buffer
      const outputPath = path.join(outputFolder, fileToDownload) // Path to save the file

      // Write the file to the output folder
      fs.writeFileSync(outputPath, buffer)

      logger.log(`HasContentChanged: Downloaded and saved: ${outputPath}`)
    } catch (error) {
      logger.log(`HasContentChanged: Error downloading file ${file} from ${fileUrl}: ${error}`)
      return false
    }
  }
  return true
}

// Helper function to delete all files in the output folder
async function DeleteFilesInOutputFolder(outputFolder: string, logger: ILoggerComponent.ILogger): Promise<void> {
  if (fs.existsSync(outputFolder)) {
    // Delete the directory and all of its contents
    try {
      fs.rmSync(outputFolder, { recursive: true, force: true })
      logger.log(`HasContentChanged: Directory ${path} deleted successfully`)
    } catch (err) {
      logger.log(`HasContentChanged: Error deleting ${path} ${err}`)
    }
  } else {
    logger.log(`HasContentChanged: Directory ${path} does not exist`)
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
  abVersion: string,
  logger: ILoggerComponent.ILogger
): Promise<boolean> {
  const entity = await getActiveEntity(entityId, contentServerUrl)
  if (entity.type === 'scene') {
    logger.info(`HasContentChanged: Entity ${entityId} is a scene`)
    const environemnt = contentServerUrl.includes('org') ? 'org' : 'zone'
    const previousHash = await getLastEntityIdByBase(entityId, entity.metadata.scene.base, contentServerUrl)
    if (previousHash !== null) {
      logger.info(`HasContentChanged: Previous hash is ${previousHash}`)
      const manifest = await getManifestFiles(previousHash, buildTarget, environemnt, logger)
      if (manifest !== null) {
        logger.info(`HasContentChanged: Manifest exists for hash ${previousHash}`)
        if (manifest.version === abVersion) {
          logger.info(`HasContentChanged: Manifest versions are the same`)
          const hashes = extractValidHashesFromEntity(entity.content)
          const doesEntityMatchHashes = AreAllContentHashesInManifest(hashes, manifest.files)
          if (doesEntityMatchHashes) {
            logger.info(`HasContentChanged: All entities contained in old manifest`)
            const allFilesDownloadSuccesfully = await downloadFilesFromManifestSuccesfully(
              hashes,
              manifest.version,
              buildTarget,
              previousHash,
              outputFolder,
              environemnt,
              logger
            )
            if (allFilesDownloadSuccesfully) {
              logger.info(`HasContentChanged: All files downloaded successfully`)
              return false
            } else {
              logger.info(`HasContentChanged Error: Some files failed to download`)
              await DeleteFilesInOutputFolder(outputFolder, logger)
            }
          } else {
            logger.info(`HasContentChanged Error: Not all entities contained in old manifest`)
          }
        } else {
          logger.info(`HasContentChanged Error: Manifest versions are different`)
        }
      } else {
        logger.info(`HasContentChanged Error: Manifest does not exist for hash ${previousHash}`)
      }
    } else {
      logger.info(`HasContentChanged Error: Previous hash is null`)
    }
  } else {
    logger.info(`HasContentChanged Error: Entity ${entityId} is not a scene`)
  }
  return true
}
