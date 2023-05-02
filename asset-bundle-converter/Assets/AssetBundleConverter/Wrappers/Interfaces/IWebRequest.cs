using System;
using System.Threading.Tasks;
using UnityEngine.Networking;

namespace DCL
{
    public interface IWebRequest
    {
        Task<DownloadHandler> Get(string url);
        void GetAsync(string url, Action<DownloadHandler> OnCompleted, Action<string> OnFail);
        Task<DownloadHandler> Post(string url, string jsonContents);
    }
}
