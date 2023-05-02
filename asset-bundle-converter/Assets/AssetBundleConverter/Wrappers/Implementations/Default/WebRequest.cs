using Cysharp.Threading.Tasks;
using System;
using System.Net.Http;
using System.Text;
using System.Threading.Tasks;
using UnityEngine;
using UnityEngine.Networking;

namespace DCL
{
    public static partial class UnityEditorWrappers
    {
        public class WebRequest : IWebRequest
        {
            private static int ASSET_REQUEST_RETRY_COUNT = 5;

            public void GetAsync(string url, Action<DownloadHandler> OnCompleted, Action<string> OnFail)
            {
                GetAsyncCoroutine(url, OnCompleted, OnFail);
            }

            public async Task<DownloadHandler> Post(string url, string json)
            {
                return await BaseRequest(url, () =>
                {
                    var request = new UnityWebRequest(url, "POST");
                    byte[] bodyRaw = Encoding.UTF8.GetBytes(json);
                    request.uploadHandler = new UploadHandlerRaw(bodyRaw);
                    request.downloadHandler = new DownloadHandlerBuffer();
                    request.SetRequestHeader("Content-Type", "application/json");

                    return request;
                });
            }

            public async Task<DownloadHandler> Get(string url)
            {
                return await BaseRequest(url, () => UnityWebRequest.Get(url));
            }

            private async Task<DownloadHandler> BaseRequest(string url, Func<UnityWebRequest> webRequest)
            {
                UnityWebRequest req;

                int retryCount = ASSET_REQUEST_RETRY_COUNT;

                do
                {
                    try
                    {
                        req = webRequest();
                        await req.SendWebRequest();
                    }
                    catch (HttpRequestException e)
                    {
                        throw new HttpRequestException($"{e.Message} -- ({url})", e);
                    }

                    retryCount--;

                    if (retryCount == 0)
                    {
                        throw new HttpRequestException($"{req.error} -- ({url})");
                    }
                } while (!req.WebRequestSucceded());

                DownloadHandler result = req.downloadHandler;

                req.disposeDownloadHandlerOnDispose = false;
                req.Dispose();

                return result;
            }

            private void GetAsyncCoroutine(string url, Action<DownloadHandler> OnCompleted, Action<string> OnFail)
            {
                UnityWebRequest req;

                int retryCount = ASSET_REQUEST_RETRY_COUNT;

                do
                {
                    req = UnityWebRequest.Get(url);

                    req.SendWebRequest();

                    retryCount--;

                    if (retryCount == 0)
                    {
                        OnFail?.Invoke(req.error);
                        //yield break;
                    }
                } while (!req.WebRequestSucceded());

                OnCompleted?.Invoke(req.downloadHandler);
            }
        }
    }
}
