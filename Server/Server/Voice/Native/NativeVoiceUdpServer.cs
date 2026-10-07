using System.Buffers;
using System.Net;
using System.Net.Sockets;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;

namespace Sloncord.Voice.Native;

internal sealed class NativeVoiceOptions
{
    public bool Enabled { get; set; } = true;
    public int Port { get; set; } = 50050;
    public string? PublicHost { get; set; }
    public int JoinTtlSeconds { get; set; } = 3600;
    public int KeepAliveTimeoutSeconds { get; set; } = 45;
}

internal sealed class NativeVoiceUdpServer : BackgroundService
{
    private readonly NativeVoiceJoinStore _joinStore;
    private readonly NativeVoiceRegistry _registry;
    private readonly IOptionsMonitor<NativeVoiceOptions> _options;
    private readonly IConfiguration _configuration;
    private readonly ILogger<NativeVoiceUdpServer> _logger;
    private UdpClient? _udp;

    public NativeVoiceUdpServer(
        NativeVoiceJoinStore joinStore,
        NativeVoiceRegistry registry,
        IOptionsMonitor<NativeVoiceOptions> options,
        IConfiguration configuration,
        ILogger<NativeVoiceUdpServer> logger)
    {
        _joinStore = joinStore;
        _registry = registry;
        _options = options;
        _configuration = configuration;
        _logger = logger;
    }

    public string ResolvePublicHost()
    {
        var opt = _options.CurrentValue;
        if (!string.IsNullOrWhiteSpace(opt.PublicHost)) return opt.PublicHost.Trim();
        var fromCfg =
            _configuration["Sloncord:Voice:Native:PublicHost"]
            ?? _configuration["SLONCORD_VOICE_NATIVE_PUBLIC_HOST"]
            ?? Environment.GetEnvironmentVariable("SLONCORD_VOICE_NATIVE_PUBLIC_HOST");
        if (!string.IsNullOrWhiteSpace(fromCfg)) return fromCfg.Trim();
        return "127.0.0.1";
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        while (!stoppingToken.IsCancellationRequested)
        {
            var opt = _options.CurrentValue;
            if (!opt.Enabled)
            {
                await Task.Delay(TimeSpan.FromSeconds(5), stoppingToken);
                continue;
            }

            try
            {
                _udp?.Dispose();
                _udp = new UdpClient(new IPEndPoint(IPAddress.Any, opt.Port));
                _logger.LogInformation("Native voice UDP listening on {Port}", opt.Port);
                await ReceiveLoopAsync(stoppingToken);
            }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
            {
                break;
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, "Native voice UDP loop failed; retry in 3s");
                await Task.Delay(TimeSpan.FromSeconds(3), stoppingToken);
            }
        }

        try { _udp?.Dispose(); } catch { /* ignore */ }
        _udp = null;
    }

    private async Task ReceiveLoopAsync(CancellationToken ct)
    {
        var udp = _udp ?? throw new InvalidOperationException("udp not started");
        var seen = 0;
        while (!ct.IsCancellationRequested)
        {
            UdpReceiveResult result;
            try
            {
                result = await udp.ReceiveAsync(ct);
            }
            catch (OperationCanceledException) when (ct.IsCancellationRequested)
            {
                break;
            }

            if (++seen % 400 == 0) _joinStore.PurgeExpired();
            HandleDatagram(udp, result.Buffer, result.RemoteEndPoint);
        }
    }

    private void HandleDatagram(UdpClient udp, byte[] data, IPEndPoint remote)
    {
        if (!NativeVoicePacket.TryParse(data, out var header, out var payload)) return;

        if (header.Kind == NativeVoicePacket.KindBind)
        {
            var tokenHex = Convert.ToHexString(payload).ToLowerInvariant();
            if (!_joinStore.TryConsume(tokenHex, out var userId, out var roomId)) return;

            var sessionId = NativeVoicePacket.DeriveSessionId(userId, roomId);
            _registry.BindPeer(roomId, userId, remote, sessionId);
            return;
        }

        // For audio/keepalive we locate sender by endpoint.
        var senderRoom = FindRoomByEndpoint(remote, out var senderUserId);
        if (senderRoom is null || senderUserId is null) return;

        _registry.Touch(senderRoom, senderUserId.Value);

        if (header.Kind == NativeVoicePacket.KindKeepAlive) return;
        if (header.Kind is not NativeVoicePacket.KindAudio
            and not NativeVoicePacket.KindVideo
            and not NativeVoicePacket.KindVideoFrag
            and not NativeVoicePacket.KindScreenAudio) return;

        var peers = _registry.GetPeersExcept(senderRoom, senderUserId.Value);
        if (peers.Count == 0) return;

        // Forward original datagram (already contains sender sessionId) to peers.
        foreach (var (_, endpoint, _) in peers)
        {
            try
            {
                udp.Send(data, data.Length, endpoint);
            }
            catch
            {
                // ignore single peer failure
            }
        }
    }

    private string? FindRoomByEndpoint(IPEndPoint remote, out Guid? userId)
    {
        userId = null;
        if (!_registry.TryFindByEndpoint(remote, out var uid, out var roomId)) return null;
        userId = uid;
        return roomId;
    }
}
