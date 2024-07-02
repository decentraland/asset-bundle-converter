// unset:none
namespace DCL.ABConverter
{
    public class ConversionState
    {
        public enum Step
        {
            IDLE,
            DUMPING_ASSETS,
            BUILDING_ASSET_BUNDLES,
            FINISHED,
        }

        private ErrorCodes errorCode = ErrorCodes.UNDEFINED;

        public Step step { get; internal set; }

        public ErrorCodes lastErrorCode
        {
            get => errorCode;

            set
            {
                // SUCCESS can't override CONVERSION_ERRORS_TOLERATED
                if (errorCode == ErrorCodes.CONVERSION_ERRORS_TOLERATED && value == ErrorCodes.SUCCESS)
                    return;

                errorCode = value;
            }
        }
    }
}
