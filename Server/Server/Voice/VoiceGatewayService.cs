using System.Net.WebSockets;
using System.Text;
using System.Text.Json;
using Microsoft.EntityFrameworkCore;
using Sloncord.Data;

namespace Sloncord.Voice;

internal sealed class VoiceGatewayService
{
    private readonly object _sync = new();
    private readonly IConfiguration _cfg;
    private readonly IDbContextFactory<SloncordDbContext> _dbFactory;
    private readonly Dictionary<WebSocket, VoiceSfuBridgeSession> _bridges = new();
    private readonly Dictionary<string, VoiceSfuBridgeSession> _detachedBridges = new(StringComparer.OrdinalIgnoreCase);

    private static string DetachedKey(string roomId, Guid userId) => $"{roomId.Trim()}:{userId:D}";

    public VoiceGatewayService(IConfiguration cfg, IDbContextFactory<SloncordDbContext> dbFactory)
    {
        _cfg = cfg;
        _dbFactory = dbFactory;
    }

    public bool Enabled => SfuTokenHelper.IsGatewayEnabled(_cfg);

    public async Task<(bool Ok, string? Error)> EnsureBridgeAsync(
        WebSocket clientSocket,
        Guid userId,
        string roomId,
        CancellationToken ct)
    {
        if (!Enabled) return (false, "gateway_disabled");

        var detachedKey = DetachedKey(roomId, userId);
        VoiceSfuBridgeSession? detached;
        lock (_sync)
        {
            _detachedBridges.TryGetValue(detachedKey, out detached);
            if (detached is not null) _detachedBridges.Remove(detachedKey);
        }
        if (detached is not null && detached.IsConnected)
        {
            detached.SetClientSocket(clientSocket);
            lock (_sync)
            {
                _bridges[clientSocket] = detached;
            }
            await SendClientJsonAsync(clientSocket, new { type = "sfuReady", roomId }, ct);
            return (true, null);
        }

        await StopBridgeAsync(clientSocket);

        if (!VoiceRoomHelper.TryParseChannelRoom(roomId, out var channelId))
            return (false, "invalid_room");

        await using var db = await _dbFactory.CreateDbContextAsync(ct);
        if (!await SloncordEndpoints.IsChannelMemberAsync(db, channelId, userId))
            return (false, "forbidden");

        var (sfuUrl, secret, ttlSeconds) = SfuTokenHelper.ReadSfuConfig(_cfg);
        if (string.IsNullOrWhiteSpace(sfuUrl))
            return (false, "sfu_url_missing");
        if (string.IsNullOrWhiteSpace(secret) || secret.Length < 16)
            return (false, "sfu_secret_missing");

        var token = SfuTokenHelper.CreateToken(secret, userId, roomId, DateTime.UtcNow.AddSeconds(ttlSeconds));
        var wsUrl = SfuTokenHelper.BuildSfuWebSocketUrl(sfuUrl, token);
        if (string.IsNullOrWhiteSpace(wsUrl))
            return (false, "sfu_url_invalid");

        VoiceSfuBridgeSession bridge;
        try
        {
            bridge = await VoiceSfuBridgeSession.ConnectAsync(
                clientSocket,
                userId,
                roomId,
                wsUrl,
                sfuUrl,
                secret,
                ttlSeconds,
                async refreshCt => await SendClientJsonAsync(
                    clientSocket,
                    new { type = "sfuBridgeRefreshed", roomId },
                    refreshCt),
                ct);
        }
        catch (Exception ex)
        {
            return (false, ex.Message);
        }

        lock (_sync)
        {
            _bridges[clientSocket] = bridge;
        }

        await SendClientJsonAsync(clientSocket, new { type = "sfuReady", roomId }, ct);
        return (true, null);
    }

    public async Task ForwardClientToSfuAsync(WebSocket clientSocket, JsonElement body, CancellationToken ct)
    {
        VoiceSfuBridgeSession? bridge;
        lock (_sync)
        {
            _bridges.TryGetValue(clientSocket, out bridge);
        }

        if (bridge is null || !bridge.IsConnected)
            throw new InvalidOperationException("sfu_bridge_missing");

        await bridge.SendUpstreamJsonAsync(body, ct);
    }

    public async Task<(bool Ok, string? Error)> ReconnectBridgeAsync(
        WebSocket clientSocket,
        Guid userId,
        CancellationToken ct)
    {
        string? roomId;
        lock (_sync)
        {
            if (_bridges.TryGetValue(clientSocket, out var existing))
                roomId = existing.RoomId;
            else
                roomId = null;
        }

        if (string.IsNullOrWhiteSpace(roomId))
            return (false, "no_active_bridge");

        return await EnsureBridgeAsync(clientSocket, userId, roomId, ct);
    }

    public void DetachBridgeForGrace(WebSocket clientSocket, Guid userId, string roomId)
    {
        VoiceSfuBridgeSession? bridge;
        lock (_sync)
        {
            if (!_bridges.TryGetValue(clientSocket, out bridge)) return;
            _bridges.Remove(clientSocket);
            _detachedBridges[DetachedKey(roomId, userId)] = bridge;
        }
    }

    public async Task DisposeDetachedBridgeAsync(string roomId, Guid userId)
    {
        var key = DetachedKey(roomId, userId);
        VoiceSfuBridgeSession? bridge;
        lock (_sync)
        {
            if (!_detachedBridges.TryGetValue(key, out bridge)) return;
            _detachedBridges.Remove(key);
        }
        await bridge.DisposeAsync();
    }

    public async Task StopBridgeAsync(WebSocket clientSocket)
    {
        VoiceSfuBridgeSession? bridge;
        lock (_sync)
        {
            if (!_bridges.TryGetValue(clientSocket, out bridge)) return;
            _bridges.Remove(clientSocket);
        }
        await bridge.DisposeAsync();
    }

    private static async Task SendClientJsonAsync(WebSocket socket, object payload, CancellationToken ct)
    {
        if (socket.State != WebSocketState.Open) return;
        var json = JsonSerializer.Serialize(payload, SloncordJson.Options);
        var bytes = Encoding.UTF8.GetBytes(json);
        try
        {
            await socket.SendAsync(bytes, WebSocketMessageType.Text, true, ct);
        }
        catch
        {
            // ignore
        }
    }
}
