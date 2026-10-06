using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Options;

namespace Sloncord.Voice.Native;

internal sealed class NativeVoiceService
{
    private readonly NativeVoiceJoinStore _joinStore;
    private readonly NativeVoiceRegistry _registry;
    private readonly IOptionsMonitor<NativeVoiceOptions> _options;
    private readonly IConfiguration _configuration;

    public NativeVoiceService(
        NativeVoiceJoinStore joinStore,
        NativeVoiceRegistry registry,
        IOptionsMonitor<NativeVoiceOptions> options,
        IConfiguration configuration)
    {
        _joinStore = joinStore;
        _registry = registry;
        _options = options;
        _configuration = configuration;
    }

    public bool IsEnabled => _options.CurrentValue.Enabled;

    public NativeVoiceJoinResult CreateJoin(Guid userId, string roomId)
    {
        var opt = _options.CurrentValue;
        var ttl = TimeSpan.FromSeconds(Math.Clamp(opt.JoinTtlSeconds, 60, 86400));
        var (tokenHex, expires) = _joinStore.Issue(userId, roomId, ttl);
        var sessionId = NativeVoicePacket.DeriveSessionId(userId, roomId);
        return new NativeVoiceJoinResult(
            ResolvePublicHost(),
            opt.Port,
            tokenHex,
            sessionId,
            expires,
            ttl.TotalSeconds);
    }

    private string ResolvePublicHost()
    {
        var opt = _options.CurrentValue;
        if (!string.IsNullOrWhiteSpace(opt.PublicHost)) return opt.PublicHost.Trim();
        var fromCfg =
            _configuration["Sloncord:Voice:Native:PublicHost"]
            ?? _configuration["SLONCORD_VOICE_NATIVE_PUBLIC_HOST"]
            ?? Environment.GetEnvironmentVariable("SLONCORD_VOICE_NATIVE_PUBLIC_HOST");
        if (!string.IsNullOrWhiteSpace(fromCfg)) return fromCfg.Trim();
        var origin =
            _configuration["SLONCORD_PUBLIC_ORIGIN"]
            ?? _configuration["Sloncord:PublicOrigin"];
        if (!string.IsNullOrWhiteSpace(origin)
            && Uri.TryCreate(origin.Trim(), UriKind.Absolute, out var originUri)
            && !string.IsNullOrWhiteSpace(originUri.Host))
            return originUri.Host;
        return "127.0.0.1";
    }

    public void Leave(Guid userId, string roomId)
    {
        _registry.RemovePeer(roomId, userId);
        _joinStore.RevokeForUserRoom(userId, roomId);
    }
}

internal readonly record struct NativeVoiceJoinResult(
    string UdpHost,
    int UdpPort,
    string SessionToken,
    ushort SessionId,
    DateTime ExpiresAtUtc,
    double TtlSeconds);
