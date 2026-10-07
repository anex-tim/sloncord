using System.Buffers;
using System.Net.WebSockets;
using System.Text;
using System.Text.Json;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Sloncord.Data;
using Sloncord.Hubs;

namespace Sloncord.Realtime;

internal sealed class RealtimeGatewayServer
{
    private readonly IServiceScopeFactory _scopeFactory;
    private readonly RealtimeGatewayHub _hub;
    private readonly Sloncord.Services.UserPresenceService _presence;
    private readonly IConfiguration _configuration;

    public RealtimeGatewayServer(
        IServiceScopeFactory scopeFactory,
        RealtimeGatewayHub hub,
        Sloncord.Services.UserPresenceService presence,
        IConfiguration configuration)
    {
        _scopeFactory = scopeFactory;
        _hub = hub;
        _presence = presence;
        _configuration = configuration;
    }

    public async Task HandleAsync(WebSocket socket, Guid userId, CancellationToken ct)
    {
        _hub.Register(socket, userId);
        await using var scope = _scopeFactory.CreateAsyncScope();
        var db = scope.ServiceProvider.GetRequiredService<SloncordDbContext>();
        var channelIds = await JoinDefaultGroupsAsync(db, socket, userId, ct);

        _presence.MarkOnline(userId);
        _presence.CancelOfflineCountdown(userId);

        foreach (var ch in channelIds)
        {
            await _hub.ToChannelAsync(ch, SloncordHubEvents.UserPresenceUpdated, new
            {
                userId = userId.ToString("D"),
                online = true,
                lastSeenAtUtc = (string?)null
            }, ct);
        }

        var buffer = ArrayPool<byte>.Shared.Rent(64 * 1024);
        var messageBytes = new List<byte>(4096);
        try
        {
            while (socket.State == WebSocketState.Open && !ct.IsCancellationRequested)
            {
                var result = await socket.ReceiveAsync(buffer.AsMemory(0, buffer.Length), ct);
                if (result.MessageType == WebSocketMessageType.Close) break;
                if (result.MessageType != WebSocketMessageType.Text) continue;

                for (var i = 0; i < result.Count; i++) messageBytes.Add(buffer[i]);
                if (!result.EndOfMessage) continue;

                var text = Encoding.UTF8.GetString(messageBytes.ToArray());
                messageBytes.Clear();
                if (string.IsNullOrWhiteSpace(text)) continue;

                JsonDocument doc;
                try { doc = JsonDocument.Parse(text); }
                catch { continue; }

                using (doc)
                {
                    if (!doc.RootElement.TryGetProperty("op", out var opEl)) continue;
                    var op = opEl.GetString() ?? "";
                    if (string.Equals(op, "ping", StringComparison.OrdinalIgnoreCase))
                    {
                        await _hub.SendJsonAsync(socket, new { op = "pong" }, ct);
                    }
                    else if (string.Equals(op, "resyncGroups", StringComparison.OrdinalIgnoreCase))
                    {
                        await JoinDefaultGroupsAsync(db, socket, userId, ct);
                    }
                    else if (string.Equals(op, "typing", StringComparison.OrdinalIgnoreCase))
                    {
                        var channelId = doc.RootElement.TryGetProperty("channelId", out var chEl)
                            ? chEl.GetString()
                            : null;
                        if (Guid.TryParse(channelId, out var chId))
                        {
                            var nickname = await db.Users.AsNoTracking()
                                .Where(u => u.Id == userId)
                                .Select(u => u.Nickname)
                                .FirstOrDefaultAsync(ct);
                            await _hub.ToChannelAsync(chId, SloncordHubEvents.Typing, new
                            {
                                channelId = chId.ToString("D"),
                                userId = userId.ToString("D"),
                                nickname
                            }, ct);
                        }
                    }
                }
            }
        }
        finally
        {
            ArrayPool<byte>.Shared.Return(buffer);
            _hub.Unregister(socket);
            _presence.MarkOffline(userId);
            if (_presence.GetConnectionCount(userId) <= 0)
            {
                var token = _presence.BeginOfflineCountdown(userId);
                _ = ScheduleOfflineBroadcastAsync(userId, token);
            }
        }
    }

    private async Task<List<Guid>> JoinDefaultGroupsAsync(SloncordDbContext db, WebSocket socket, Guid userId, CancellationToken ct)
    {
        var groups = new List<string> { $"{SloncordHub.GroupUserPrefix}{userId:N}" };
        var channelIds = await db.ChannelMembers.AsNoTracking()
            .Where(m => m.UserId == userId)
            .Select(m => m.ChannelId)
            .ToListAsync(ct);
        foreach (var id in channelIds)
            groups.Add($"{SloncordHub.GroupChannelPrefix}{id:N}");

        if (await SloncordPlatformPermissions.HasPermissionAsync(_configuration, db, userId, PlatformModeratorPerm.ViewReports, ct))
            groups.Add(SloncordHub.GroupPlatformModerators);

        _hub.SetGroups(socket, groups);
        await _hub.SendJsonAsync(socket, new { op = "ready", userId = userId.ToString("D") }, ct);
        return channelIds;
    }

    private Task ScheduleOfflineBroadcastAsync(Guid userId, CancellationToken token)
    {
        return Task.Run(async () =>
        {
            try
            {
                await Task.Delay(TimeSpan.FromMinutes(1), token);
            }
            catch
            {
                return;
            }

            if (_presence.IsOnline(userId)) return;

            await using var scope = _scopeFactory.CreateAsyncScope();
            var db = scope.ServiceProvider.GetRequiredService<SloncordDbContext>();
            var now = DateTime.UtcNow;
            try
            {
                var u = await db.Users.FirstOrDefaultAsync(x => x.Id == userId);
                if (u is not null)
                {
                    u.LastSeenAtUtc = now;
                    await db.SaveChangesAsync();
                }
            }
            catch
            {
                // ignore
            }

            var chIds = await db.ChannelMembers.AsNoTracking()
                .Where(m => m.UserId == userId)
                .Select(m => m.ChannelId)
                .ToListAsync();
            foreach (var ch in chIds)
            {
                await _hub.ToChannelAsync(ch, SloncordHubEvents.UserPresenceUpdated, new
                {
                    userId = userId.ToString("D"),
                    online = false,
                    lastSeenAtUtc = now.ToString("O")
                });
            }
        });
    }

}
