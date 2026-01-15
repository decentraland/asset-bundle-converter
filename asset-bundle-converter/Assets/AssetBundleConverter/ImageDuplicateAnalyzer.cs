using AssetBundleConverter.Wrappers.Interfaces;
using DCL;
using DCL.ABConverter;
using System;
using System.Collections.Generic;
using System.IO;
using System.Security.Cryptography;

namespace AssetBundleConverter
{
    /// <summary>
    /// Analyzes images during extraction to identify duplicates using CRC/hash checks.
    /// This enables potential image reuse optimization by detecting textures that are identical
    /// even when they come from different GLTFs.
    /// When duplicates are found, the original texture is moved to a shared folder.
    /// </summary>
    public class ImageDuplicateAnalyzer
    {
        public const string SHARED_TEXTURES_FOLDER = "_SharedTextures";

        /// <summary>
        /// Information about a detected duplicate image
        /// </summary>
        public struct DuplicateInfo
        {
            public string originalPath;
            public string sharedPath;
            public string duplicatePath;
            public string sourceGltfFolder;
            public string hash;
            public long fileSize;
        }

        /// <summary>
        /// Statistics about the image analysis
        /// </summary>
        public struct AnalysisStats
        {
            public int totalImagesAnalyzed;
            public int uniqueImages;
            public int duplicatesFound;
            public int sharedTextures;
            public long totalBytesAnalyzed;
            public long potentialBytesSaved;
        }

        private readonly Dictionary<string, string> hashToPath = new();
        private readonly Dictionary<string, string> pathToHash = new();
        private readonly HashSet<string> movedToShared = new();
        private readonly Dictionary<string, string> originalPathsToUpdate = new(); // hash -> original path (for material updates)
        private readonly List<DuplicateInfo> duplicates = new();
        private readonly bool enabled;
        private readonly IABLogger logger;
        private readonly IFile file;
        private readonly IDirectory directory;
        private readonly IAssetDatabase assetDatabase;
        private readonly string sharedTexturesPath;

        private int totalImagesAnalyzed;
        private long totalBytesAnalyzed;
        private long potentialBytesSaved;

        /// <summary>
        /// Whether the analyzer is enabled
        /// </summary>
        public bool IsEnabled => enabled;

        /// <summary>
        /// List of all detected duplicates
        /// </summary>
        public IReadOnlyList<DuplicateInfo> Duplicates => duplicates;

        /// <summary>
        /// Path to the shared textures folder
        /// </summary>
        public string SharedTexturesPath => sharedTexturesPath;

        /// <summary>
        /// Number of textures moved to the shared folder
        /// </summary>
        public int SharedTextureCount => movedToShared.Count;

        /// <summary>
        /// Creates a new ImageDuplicateAnalyzer
        /// </summary>
        /// <param name="enabled">Whether duplicate analysis is enabled</param>
        /// <param name="downloadedPath">Base path where downloaded assets are stored</param>
        /// <param name="file">File operations interface</param>
        /// <param name="directory">Directory operations interface</param>
        /// <param name="assetDatabase">Asset database interface</param>
        /// <param name="logger">Optional logger for verbose output</param>
        public ImageDuplicateAnalyzer(
            bool enabled,
            string downloadedPath,
            IFile file,
            IDirectory directory,
            IAssetDatabase assetDatabase,
            IABLogger logger = null)
        {
            this.enabled = enabled;
            this.file = file;
            this.directory = directory;
            this.assetDatabase = assetDatabase;
            this.logger = logger;

            // Create the shared textures folder path
            sharedTexturesPath = PathUtils.FixDirectorySeparator(
                Path.Combine(downloadedPath, SHARED_TEXTURES_FOLDER) + Path.DirectorySeparatorChar);
        }

        /// <summary>
        /// Ensures the shared textures folder exists
        /// </summary>
        public void EnsureSharedFolderExists()
        {
            if (enabled && !directory.Exists(sharedTexturesPath))
            {
                directory.CreateDirectory(sharedTexturesPath);
                logger?.Verbose($"[ImageDuplicateAnalyzer] Created shared textures folder: {sharedTexturesPath}");
            }
        }

        /// <summary>
        /// Analyzes image data and returns whether it's a duplicate.
        /// If it's a duplicate, returns the path to the shared texture.
        /// When a first duplicate is found, moves the original to the shared folder.
        /// </summary>
        /// <param name="imageData">The raw image bytes</param>
        /// <param name="proposedPath">The path where this image would be saved</param>
        /// <param name="sourceGltfFolder">The GLTF folder this texture belongs to (for tracking)</param>
        /// <param name="sharedPath">If duplicate or becomes shared, the path to the shared texture</param>
        /// <returns>True if this is a duplicate image</returns>
        public bool AnalyzeImage(byte[] imageData, string proposedPath, string sourceGltfFolder, out string sharedPath)
        {
            sharedPath = null;

            if (!enabled || imageData == null || imageData.Length == 0)
                return false;

            totalImagesAnalyzed++;
            totalBytesAnalyzed += imageData.Length;

            string hash = ComputeHash(imageData);

            if (hashToPath.TryGetValue(hash, out string existingPath))
            {
                // This is a duplicate - check if original needs to be moved to shared folder
                string finalSharedPath = EnsureTextureIsShared(hash, existingPath, imageData);

                duplicates.Add(new DuplicateInfo
                {
                    originalPath = existingPath,
                    sharedPath = finalSharedPath,
                    duplicatePath = proposedPath,
                    sourceGltfFolder = sourceGltfFolder,
                    hash = hash,
                    fileSize = imageData.Length
                });

                potentialBytesSaved += imageData.Length;
                sharedPath = finalSharedPath;

                logger?.Verbose($"[ImageDuplicateAnalyzer] Duplicate found: {Path.GetFileName(proposedPath)} -> shared as {Path.GetFileName(finalSharedPath)} (hash: {hash.Substring(0, 8)}...)");

                return true;
            }

            // First occurrence of this image
            hashToPath[hash] = proposedPath;
            pathToHash[proposedPath] = hash;

            return false;
        }

        /// <summary>
        /// Ensures a texture is in the shared folder. If not already there, moves it.
        /// Also deletes the original file to avoid duplication.
        /// </summary>
        private string EnsureTextureIsShared(string hash, string originalPath, byte[] imageData)
        {
            // Check if already moved to shared
            if (movedToShared.Contains(hash))
            {
                // Return the current path which should be the shared path
                return hashToPath[hash];
            }

            EnsureSharedFolderExists();

            // Generate shared path using hash for uniqueness
            string extension = Path.GetExtension(originalPath);
            if (string.IsNullOrEmpty(extension))
                extension = ".png";

            string sharedFileName = $"{hash.Substring(0, 16)}{extension}";
            string newSharedPath = PathUtils.FixDirectorySeparator(Path.Combine(sharedTexturesPath, sharedFileName));

            try
            {
                // Write to shared location (we have the bytes, so just write directly)
                file.WriteAllBytes(newSharedPath, imageData);
                assetDatabase.ImportAsset(newSharedPath, UnityEditor.ImportAssetOptions.ForceSynchronousImport);

                // Delete the original file to avoid duplication
                // The original file was saved when the first GLTF with this texture was processed
                if (file.Exists(originalPath))
                {
                    file.Delete(originalPath);
                    logger?.Verbose($"[ImageDuplicateAnalyzer] Deleted original texture: {originalPath}");
                }

                // Track the original path so we can update materials later
                originalPathsToUpdate[hash] = originalPath;

                // Update tracking to point to shared location
                hashToPath[hash] = newSharedPath;
                pathToHash.Remove(originalPath);
                pathToHash[newSharedPath] = hash;
                movedToShared.Add(hash);

                logger?.Verbose($"[ImageDuplicateAnalyzer] Texture promoted to shared: {Path.GetFileName(originalPath)} -> {sharedFileName}");

                return newSharedPath;
            }
            catch (Exception e)
            {
                logger?.Error($"[ImageDuplicateAnalyzer] Failed to move texture to shared folder: {e.Message}");
                return originalPath;
            }
        }

        /// <summary>
        /// Computes a hash for the given image data
        /// </summary>
        private string ComputeHash(byte[] data)
        {
            using (var sha256 = SHA256.Create())
            {
                byte[] hashBytes = sha256.ComputeHash(data);
                return BitConverter.ToString(hashBytes).Replace("-", "").ToLowerInvariant();
            }
        }

        /// <summary>
        /// Gets the hash for an already-analyzed path
        /// </summary>
        public bool TryGetHash(string path, out string hash)
        {
            return pathToHash.TryGetValue(path, out hash);
        }

        /// <summary>
        /// Gets the path for a given hash (could be original or shared)
        /// </summary>
        public bool TryGetPathForHash(string hash, out string path)
        {
            return hashToPath.TryGetValue(hash, out path);
        }

        /// <summary>
        /// Checks if a hash has been moved to shared folder
        /// </summary>
        public bool IsShared(string hash)
        {
            return movedToShared.Contains(hash);
        }

        /// <summary>
        /// Gets the mapping of original paths to shared paths for textures that were moved.
        /// This can be used to update materials that were created before the texture was moved to shared.
        /// </summary>
        public Dictionary<string, string> GetOriginalToSharedMappings()
        {
            var mappings = new Dictionary<string, string>();
            foreach (var kvp in originalPathsToUpdate)
            {
                string hash = kvp.Key;
                string originalPath = kvp.Value;
                if (hashToPath.TryGetValue(hash, out string sharedPath))
                {
                    mappings[originalPath] = sharedPath;
                }
            }
            return mappings;
        }

        /// <summary>
        /// Gets the current analysis statistics
        /// </summary>
        public AnalysisStats GetStats()
        {
            return new AnalysisStats
            {
                totalImagesAnalyzed = totalImagesAnalyzed,
                uniqueImages = hashToPath.Count,
                duplicatesFound = duplicates.Count,
                sharedTextures = movedToShared.Count,
                totalBytesAnalyzed = totalBytesAnalyzed,
                potentialBytesSaved = potentialBytesSaved
            };
        }

        /// <summary>
        /// Generates a summary report of the analysis
        /// </summary>
        public string GenerateReport()
        {
            if (!enabled)
                return "[ImageDuplicateAnalyzer] Analysis disabled";

            var stats = GetStats();
            var report = $"[ImageDuplicateAnalyzer] Analysis Report:\n";
            report += $"  Total images analyzed: {stats.totalImagesAnalyzed}\n";
            report += $"  Unique images: {stats.uniqueImages}\n";
            report += $"  Duplicates found: {stats.duplicatesFound}\n";
            report += $"  Textures moved to shared folder: {stats.sharedTextures}\n";
            report += $"  Total bytes analyzed: {FormatBytes(stats.totalBytesAnalyzed)}\n";
            report += $"  Bytes saved by reuse: {FormatBytes(stats.potentialBytesSaved)}\n";

            if (stats.totalImagesAnalyzed > 0)
            {
                float dupePercent = (float)stats.duplicatesFound / stats.totalImagesAnalyzed * 100f;
                report += $"  Duplicate percentage: {dupePercent:F1}%\n";
            }

            if (movedToShared.Count > 0)
            {
                report += $"\n  Shared Textures Folder: {sharedTexturesPath}\n";
            }

            if (duplicates.Count > 0)
            {
                report += "\n  Duplicate Details (GLTF folder -> shared texture):\n";
                foreach (var dupe in duplicates)
                {
                    string gltfFolder = !string.IsNullOrEmpty(dupe.sourceGltfFolder) 
                        ? Path.GetFileName(dupe.sourceGltfFolder.TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar))
                        : "unknown";
                    report += $"    - GLTF: {gltfFolder} | texture: {Path.GetFileName(dupe.duplicatePath)} -> {dupe.sharedPath} ({FormatBytes(dupe.fileSize)})\n";
                }
            }

            return report;
        }

        /// <summary>
        /// Clears all tracked data
        /// </summary>
        public void Clear()
        {
            hashToPath.Clear();
            pathToHash.Clear();
            movedToShared.Clear();
            originalPathsToUpdate.Clear();
            duplicates.Clear();
            totalImagesAnalyzed = 0;
            totalBytesAnalyzed = 0;
            potentialBytesSaved = 0;
        }

        private static string FormatBytes(long bytes)
        {
            string[] suffixes = { "B", "KB", "MB", "GB" };
            int suffixIndex = 0;
            double size = bytes;

            while (size >= 1024 && suffixIndex < suffixes.Length - 1)
            {
                size /= 1024;
                suffixIndex++;
            }

            return $"{size:F2} {suffixes[suffixIndex]}";
        }
    }
}
