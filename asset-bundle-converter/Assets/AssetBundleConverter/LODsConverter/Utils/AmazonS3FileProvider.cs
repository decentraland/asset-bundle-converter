using System;
using System.IO;
using System.Threading.Tasks;
using Amazon;
using Amazon.S3;
using Amazon.S3.Model;
using JetBrains.Annotations;

namespace AssetBundleConverter.LODsConverter.Utils
{
    public class AmazonS3FileProvider : IFileDownloader
    {
        private readonly string bucketName = "your-bucket-name";
        private readonly string directoryPath = "your-directory-path/"; // Ensure it ends with a '/'
        private readonly string outputPath = "your-output-path";
        private static readonly RegionEndpoint bucketRegion = RegionEndpoint.USEast1; // Update to your bucket's region
        private readonly IAmazonS3 s3Client;

        public AmazonS3FileProvider(string bucketName, string bucketDirectory, string outputPath)
        {
            var config = new AmazonS3Config();
            config.RegionEndpoint = bucketRegion;
            config.ServiceURL = "http://localhost:4566"; // Ensure to use the correct endpoint            
            s3Client = new AmazonS3Client(config);
            this.bucketName = bucketName;
            directoryPath = bucketDirectory;
            this.outputPath = outputPath;
        }

        [CanBeNull]
        public async Task<string[]> Download()
        {
            try
            {
                var request = new ListObjectsV2Request
                {
                    BucketName = bucketName, Prefix = directoryPath
                };

                ListObjectsV2Response response;
                do
                {
                    response = await s3Client.ListObjectsV2Async(request);
                    foreach (var entry in response.S3Objects)
                    {
                        Console.WriteLine($"Downloading {entry.Key}...");
                        await DownloadFileAsync(entry.Key);
                    }

                    request.ContinuationToken = response.NextContinuationToken;
                } while (response.IsTruncated);
            }
            catch (AmazonS3Exception e)
            {
                Console.WriteLine($"Error encountered on server. Message:'{e.Message}' when listing objects");
            }
            catch (Exception e)
            {
                Console.WriteLine($"Unknown encountered on server. Message:'{e.Message}' when listing objects");
            }

            return Array.Empty<string>();
        }

        private async Task DownloadFileAsync(string keyName)
        {
            string filePath = Path.Combine(outputPath, keyName.Replace("/", "\\"));
            // Ensure the directory exists
            Directory.CreateDirectory(Path.GetDirectoryName(filePath));

            try
            {
                var request = new GetObjectRequest
                {
                    BucketName = bucketName, Key = keyName
                };

                using (var response = await s3Client.GetObjectAsync(request))
                using (var responseStream = response.ResponseStream)
                using (var fileStream = File.Create(filePath))
                {
                    await responseStream.CopyToAsync(fileStream);
                    Console.WriteLine($"{keyName} has been downloaded to {filePath}");
                }
            }
            catch (AmazonS3Exception e)
            {
                Console.WriteLine($"Error encountered on server. Message:'{e.Message}' when downloading an object");
            }
            catch (Exception e)
            {
                Console.WriteLine($"Unknown encountered on server. Message:'{e.Message}' when downloading an object");
            }
        }
    }
}