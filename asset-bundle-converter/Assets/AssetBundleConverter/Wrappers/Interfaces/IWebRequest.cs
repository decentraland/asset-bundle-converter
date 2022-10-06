using System;
using UnityEngine.Networking;

namespace DCL
{
    public interface IWebRequest
    {
        DownloadHandler Get(string url);
        void GetAsync(string url, Action<DownloadHandler> OnCompleted, Action<string> OnFail);
        DownloadHandler Post(string url, string jsonContents);
    }
}