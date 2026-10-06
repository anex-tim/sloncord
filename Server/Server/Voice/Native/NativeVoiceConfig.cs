using Microsoft.Extensions.Configuration;

namespace Sloncord.Voice.Native;

internal static class NativeVoiceConfig
{
    public static bool IsNativePrimary(IConfiguration cfg)
    {
        var raw =
            cfg["Sloncord:Voice:Mode"]
            ?? cfg["SLONCORD_VOICE_MODE"]
            ?? Environment.GetEnvironmentVariable("SLONCORD_VOICE_MODE")
            ?? "native";
        return string.Equals(raw.Trim(), "native", StringComparison.OrdinalIgnoreCase);
    }

    public static bool IsNativeEnabled(IConfiguration cfg)
    {
        var raw =
            cfg["Sloncord:Voice:Native:Enabled"]
            ?? cfg["SLONCORD_VOICE_NATIVE_ENABLED"]
            ?? Environment.GetEnvironmentVariable("SLONCORD_VOICE_NATIVE_ENABLED")
            ?? "1";
        if (string.Equals(raw.Trim(), "0", StringComparison.OrdinalIgnoreCase)
            || string.Equals(raw.Trim(), "false", StringComparison.OrdinalIgnoreCase))
            return false;
        return true;
    }
}
