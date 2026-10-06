using Microsoft.AspNetCore.SignalR;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Configuration;
using Sloncord.Data;
using Sloncord.Services;

namespace Sloncord.Hubs;

public sealed class SloncordHub : Hub
{
    public const string GroupUserPrefix = "user:";
    public const string GroupChannelPrefix = "channel:";
    public const string GroupPlatformModerators = "platform-moderators";

    private readonly IServiceScopeFactory _scopeFactory;
    private readonly UserPresenceService _presence;
    private readonly IHubContext<SloncordHub> _hub;

    public SloncordHub(IServiceScopeFactory scopeFactory, UserPresenceService presence, IHubContext<SloncordHub> hub)
    {
        _scopeFactory = scopeFactory;
        _presence = presence;
        _hub = hub;
    }

    public override async Task OnConnectedAsync()
    {
        var http = Context.GetHttpContext();
        var token = http?.Request.Query["access_token"].FirstOrDefault();
        if (!string.IsNullOrWhiteSpace(token))
        {
            await using var scope = _scopeFactory.CreateAsyncScope();
            var db = scope.ServiceProvider.GetRequiredService<SloncordDbContext>();
            var config = scope.ServiceProvider.GetRequiredService<IConfiguration>();
            var userId = await ResolveUserIdFromTokenAsync(db, token, Context.ConnectionAborted);
            if (userId is not null)
            {
                Context.Items["uid"] = userId.Value;
                if (await SloncordPlatformPermissions.HasPermissionAsync(
                        config, db, userId.Value, PlatformModeratorPerm.ViewReports, Context.ConnectionAborted))
                {
                    await Groups.AddToGroupAsync(Context.ConnectionId, GroupPlatformModerators, Context.ConnectionAborted);
                }
                await JoinUserChannelsAsync(db, userId.Value, Context.ConnectionAborted);
                _presence.MarkOnline(userId.Value);
                _presence.CancelOfflineCountdown(userId.Value);

                // Broadcast presence to all channels where this user is a member.
                var chIds = await db.ChannelMembers.AsNoTracking()
                    .Where(m => m.UserId == userId.Value)
                    .Select(m => m.ChannelId)
                    .ToListAsync(Context.ConnectionAborted);
                foreach (var ch in chIds)
                {
                    await _hub.Clients.Group($"{GroupChannelPrefix}{ch:N}")
                        .SendAsync(SloncordHubEvents.UserPresenceUpdated, new
                        {
                            userId = userId.Value.ToString("D"),
                            online = true,
                            lastSeenAtUtc = (string?)null
                        }, Context.ConnectionAborted);
                }
            }
        }

        await base.OnConnectedAsync();
    }

    public override async Task OnDisconnectedAsync(Exception? exception)
    {
        if (Context.Items.TryGetValue("uid", out var v) && v is Guid userId)
        {
            _presence.MarkOffline(userId);
            // Grace period: only mark offline if the user hasn't reconnected within 60s.
            if (_presence.GetConnectionCount(userId) <= 0)
            {
                CancellationToken token = _presence.BeginOfflineCountdown(userId);
                _ = Task.Run(async () =>
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

                    try
                    {
                        var chIds = await db.ChannelMembers.AsNoTracking()
                            .Where(m => m.UserId == userId)
                            .Select(m => m.ChannelId)
                            .ToListAsync();
                        foreach (var ch in chIds)
                        {
                            await _hub.Clients.Group($"{GroupChannelPrefix}{ch:N}")
                                .SendAsync(SloncordHubEvents.UserPresenceUpdated, new
                                {
                                    userId = userId.ToString("D"),
                                    online = false,
                                    lastSeenAtUtc = now.ToString("O")
                                });
                        }
                    }
                    catch
                    {
                        // ignore
                    }
                });
            }
        }
        await base.OnDisconnectedAsync(exception);
    }

    /// <summary>
    /// Re-join SignalR groups after membership changes (invites/new DMs) without reconnecting.
    /// </summary>
    public async Task ResyncGroups()
    {
        if (!Context.Items.TryGetValue("uid", out var v) || v is not Guid userId)
        {
            return;
        }

        await using var scope = _scopeFactory.CreateAsyncScope();
        var db = scope.ServiceProvider.GetRequiredService<SloncordDbContext>();
        await JoinUserChannelsAsync(db, userId, Context.ConnectionAborted);
    }

    // Client can call this after selecting a channel, if we don't auto-join on connect.
    public async Task JoinChannel(Guid channelId)
    {
        await Groups.AddToGroupAsync(Context.ConnectionId, $"{GroupChannelPrefix}{channelId:N}");
    }

    public async Task LeaveChannel(Guid channelId)
    {
        await Groups.RemoveFromGroupAsync(Context.ConnectionId, $"{GroupChannelPrefix}{channelId:N}");
    }

    /// <summary>
    /// Lightweight typing indicator broadcast (Discord-like).
    /// Client should call this periodically while typing; receivers apply a short TTL (~3s).
    /// </summary>
    public async Task Typing(string channelId)
    {
        if (!Context.Items.TryGetValue("uid", out var v) || v is not Guid userId)
        {
            return;
        }

        if (!Guid.TryParse(channelId, out var chId))
        {
            return;
        }

        string? nickname = null;
        try
        {
            await using var scope = _scopeFactory.CreateAsyncScope();
            var db = scope.ServiceProvider.GetRequiredService<SloncordDbContext>();
            nickname = await db.Users
                .AsNoTracking()
                .Where(u => u.Id == userId)
                .Select(u => u.Nickname)
                .FirstOrDefaultAsync(Context.ConnectionAborted);
        }
        catch
        {
            // ignore
        }

        await _hub.Clients.Group($"{GroupChannelPrefix}{chId:N}")
            .SendAsync(SloncordHubEvents.Typing, new
            {
                channelId = chId.ToString("D"),
                userId = userId.ToString("D"),
                nickname
            }, Context.ConnectionAborted);
    }

    private static async Task<Guid?> ResolveUserIdFromTokenAsync(
        SloncordDbContext db, string token, CancellationToken ct)
    {
        var t = token.Trim();
        if (t.Length < 8) return null;
        if (t.StartsWith("Bearer ", StringComparison.OrdinalIgnoreCase)) t = t[7..].Trim();

        var session = await db.Sessions
            .AsNoTracking()
            .FirstOrDefaultAsync(s => s.Token == t, ct);

        if (session is null) return null;
        if (await SloncordPlatformPermissions.IsPlatformBannedAsync(db, session.UserId, ct))
            return null;

        return session.UserId;
    }

    private async Task JoinUserChannelsAsync(SloncordDbContext db, Guid userId, CancellationToken ct)
    {
        await Groups.AddToGroupAsync(Context.ConnectionId, $"{GroupUserPrefix}{userId:N}");

        var channelIds = await db.ChannelMembers
            .AsNoTracking()
            .Where(m => m.UserId == userId)
            .Select(m => m.ChannelId)
            .ToListAsync(ct);

        foreach (var id in channelIds)
        {
            await Groups.AddToGroupAsync(Context.ConnectionId, $"{GroupChannelPrefix}{id:N}");
        }
    }
}

public static class SloncordHubEvents
{
    public const string MessageCreated = "message.created";
    public const string MessageUpdated = "message.updated";
    public const string MessageDeleted = "message.deleted";
    public const string Typing = "typing";

    public const string ChannelUpdated = "channel.updated";
    public const string DmCreated = "dm.created";

    public const string ReadStateUpdated = "read.updated";
    public const string UnreadChanged = "unread.changed";
    public const string ChannelListUpdated = "channelList.updated";
    public const string ServerListUpdated = "serverList.updated";
    public const string VoicePresenceUpdated = "voice.presence";
    public const string VoiceMoved = "voice.moved";
    public const string UserPresenceUpdated = "user.presence";

    // DM calls (ringing)
    public const string DmCallIncoming = "dm.call.incoming";
    public const string DmCallResponse = "dm.call.response"; // { callId, channelId, fromUserId, action }
    public const string DmCallCancelled = "dm.call.cancelled";
    public const string PlatformBanned = "platform.banned";
    public const string ChatMuteChanged = "chat.mute.changed";
    public const string SessionsRevoked = "user.sessions.revoked";
    public const string PlatformReportsChanged = "platform.reports.changed";
    public const string UserTeamChanged = "user.team.changed";
}
