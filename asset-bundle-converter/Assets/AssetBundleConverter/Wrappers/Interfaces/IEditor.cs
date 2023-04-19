// unset:none
using System;

namespace DCL
{
    public interface IEditor
    {
        public void DisplayProgressBar(string title, string body, float progress);

        void ClearProgressBar();
    }
}
