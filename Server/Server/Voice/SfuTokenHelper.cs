using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

using Sloncord.Voice.Native;

namespace Sloncord.Voice;

internal static class SfuTokenHelper
{
    public static string CreateToken(string secret, Guid userId, string roomId, DateTime expiresUtc)
    {
        var payloadObj = new
        {
            v = 1,
            userId = userId.ToString("D"),
            roomId,
            exp = expiresUtc.ToString("O")
        };
        var payloadJson = JsonSerializer.Serialize(payloadObj);
        var payload = Base64UrlEncode(Encoding.UTF8.GetBytes(payloadJson));

        using var h = new HMACSHA256(Encoding.UTF8.GetBytes(secret));
        var sig = h.ComputeHash(Encoding.UTF8.GetBytes(payload));
        return $"{payload}.{Base64UrlEncode(sig)}";
    }

    public static (string Url, string Secret, int TokenTtlSeconds) ReadSfuConfig(IConfiguration cfg)
    {
        var sfuUrl =
            cfg["Sloncord:Voice:Sfu:Url"]
            ?? cfg["SLONCORD_SFU_URL"]
            ?? Environment.GetEnvironmentVariable("SLONCORD_SFU_URL")
            ?? "";

        var secret =
            cfg["Sloncord:Voice:Sfu:Secret"]
            ?? cfg["SLONCORD_SFU_SECRET"]
            ?? Environment.GetEnvironmentVariable("SLONCORD_SFU_SECRET")
            ?? "";

        var ttlRaw =
            cfg["Sloncord:Voice:Sfu:TokenTtlSeconds"]
            ?? cfg["SLONCORD_SFU_TOKEN_TTL_SECONDS"]
            ?? Environment.GetEnvironmentVariable("SLONCORD_SFU_TOKEN_TTL_SECONDS")
            ?? "43200";

        _ = int.TryParse(ttlRaw, out var ttlSeconds);
        if (ttlSeconds <= 0) ttlSeconds = 43200;
        if (ttlSeconds > 24 * 3600) ttlSeconds = 24 * 3600;

        return (sfuUrl.Trim(), secret.Trim(), ttlSeconds);
    }

    public static bool IsGatewayEnabled(IConfiguration cfg)
    {
        if (NativeVoiceConfig.IsNativePrimary(cfg) && NativeVoiceConfig.IsNativeEnabled(cfg))
            return false;
        var raw =
            cfg["Sloncord:Voice:Gateway:Enabled"]
            ?? cfg["SLONCORD_VOICE_GATEWAY_ENABLED"]
            ?? Environment.GetEnvironmentVariable("SLONCORD_VOICE_GATEWAY_ENABLED")
            ?? "true";
        return !string.Equals(raw.Trim(), "false", StringComparison.OrdinalIgnoreCase)
               && !string.Equals(raw.Trim(), "0", StringComparison.OrdinalIgnoreCase);
    }

    public static int ReadGraceSeconds(IConfiguration cfg)
    {
        var raw =
            cfg["Sloncord:Voice:Gateway:GraceSeconds"]
            ?? cfg["SLONCORD_VOICE_GATEWAY_GRACE_SECONDS"]
            ?? Environment.GetEnvironmentVariable("SLONCORD_VOICE_GATEWAY_GRACE_SECONDS")
            ?? "45";
        if (!int.TryParse(raw, out var sec)) sec = 45;
        if (sec < 0) sec = 0;
        if (sec > 300) sec = 300;
        return sec;
    }

    public static string BuildSfuWebSocketUrl(string sfuUrl, string token)
    {
        var baseUrl = sfuUrl.Trim();
        if (string.IsNullOrWhiteSpace(baseUrl)) return "";
        if (baseUrl.Contains("token=", StringComparison.OrdinalIgnoreCase)) return baseUrl;
        var sep = baseUrl.Contains('?') ? "&" : "?";
        return $"{baseUrl}{sep}token={Uri.EscapeDataString(token)}";
    }

    private static string Base64UrlEncode(byte[] data) =>
        Convert.ToBase64String(data).TrimEnd('=').Replace('+', '-').Replace('/', '_');
}
