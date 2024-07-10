using System;
using Unity.Collections.LowLevel.Unsafe;
using UnityEditor;

namespace AssetBundleConverter.Persistence
{
    public static class PersistentSetting
    {
        private const string PROJECT_PREFIX = "ASSET_BUNDLE_CONVERTER_";

        public static PersistentSetting<bool> CreateBool(string key, bool defaultValue)
        {
            key = PROJECT_PREFIX + key;

            PersistentSetting<bool>.SetAccessors(
                static (key, defaultValue) => EditorPrefs.GetInt(key, defaultValue ? 1 : 0) == 1,
                static (key, value) => EditorPrefs.SetInt(key, value ? 1 : 0)
            );

            return new PersistentSetting<bool>(key, defaultValue);
        }

        public static PersistentSetting<int> CreateInt(string key, int defaultValue)
        {
            key = PROJECT_PREFIX + key;

            PersistentSetting<int>.SetAccessors(
                static (key, defaultValue) => EditorPrefs.GetInt(key, defaultValue),
                static (key, value) => EditorPrefs.SetInt(key, value)
            );

            return new PersistentSetting<int>(key, defaultValue);
        }

        public static PersistentSetting<float> CreateFloat(string key, float defaultValue)
        {
            key = PROJECT_PREFIX + key;

            PersistentSetting<float>.SetAccessors(
                static (key, defaultValue) => EditorPrefs.GetFloat(key, defaultValue),
                static (key, value) => EditorPrefs.SetFloat(key, value)
            );

            return new PersistentSetting<float>(key, defaultValue);
        }

        public static PersistentSetting<T> CreateEnum<T>(string key, T defaultValue) where T: unmanaged, Enum
        {
            PersistentSetting<T>.SetAccessors(
                static (key, defaultValue) => FromInt<T>(EditorPrefs.GetInt(key, ToInt(defaultValue))),
                static (key, value) => EditorPrefs.SetInt(key, ToInt(value))
            );

            return new PersistentSetting<T>(key, defaultValue);
        }

        private static unsafe int ToInt<T>(T @enum) where T: unmanaged, Enum
        {
            return sizeof(T) switch
                   {
                       sizeof(byte) => *(byte*)&@enum,
                       sizeof(short) => *(short*)&@enum,
                       sizeof(int) => *(int*)&@enum,
                       sizeof(long) => (int)*(long*)&@enum,
                       _ => 0,
                   };
        }

        private static unsafe T FromInt<T>(int value) where T: unmanaged, Enum
        {
            switch (sizeof(T))
            {
                case sizeof(byte):
                    var @byte = (byte)value;
                    return UnsafeUtility.As<byte, T>(ref @byte);
                case sizeof(short):
                    var @short = (short)value;
                    return UnsafeUtility.As<short, T>(ref @short);
                case sizeof(int):
                    return UnsafeUtility.As<int, T>(ref value);
                case sizeof(long):
                    var @long = (long)value;
                    return UnsafeUtility.As<long, T>(ref @long);
                default: return default(T);
            }
        }
    }

    public readonly struct PersistentSetting<T>
    {
        private static Func<string, T, T> getValue;
        private static Action<string, T> setValue;
        internal readonly T defaultValue;

        private readonly string key;

        public PersistentSetting(string key, T defaultValue)
        {
            this.key = key;
            this.defaultValue = defaultValue;
            Value = getValue!(key, defaultValue)!;
        }

        public static void SetAccessors(Func<string, T, T> getValueFunc, Action<string, T> setValueFunc)
        {
            getValue ??= getValueFunc;
            setValue ??= setValueFunc;
        }

        public T Value
        {
            get => getValue!(key, defaultValue)!;
            set => setValue!(key, value);
        }

        public static implicit operator T(PersistentSetting<T> setting) => setting.Value;
    }
}
