using System.Text;
using UnityEngine.Networking;

namespace DCL
{
    public class DownloadHandlerMock : DownloadHandlerScript
    {
        private readonly string mockedText = "example";

        protected override string GetText() =>
            mockedText;

        protected override byte[] GetData() =>
            Encoding.UTF8.GetBytes(mockedText);
    }
}
