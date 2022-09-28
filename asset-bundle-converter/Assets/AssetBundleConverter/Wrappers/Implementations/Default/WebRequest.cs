using System;
using System.Net.Http;
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

            public DownloadHandler Get(string url)
            {
                UnityWebRequest req;

                int retryCount = ASSET_REQUEST_RETRY_COUNT;

                do
                {
                    try
                    {
                        req = UnityWebRequest.Get(url);
                        var op = req.SendWebRequest();
                        while (op.isDone == false) { }
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
        }
    }
}