using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Configuration;
using Sloncord.Data;

namespace Sloncord;

internal static class SloncordServerPermissions
{
    public static async Task<ServerEntity?> GetServerAsync(SloncordDbContext db, Guid serverId, CancellationToken ct = default)
        => await db.Servers.AsNoTracking().FirstOrDefaultAsync(s => s.Id == serverId, ct);

    public static bool IsServerOwner(ServerEntity srv, Guid userId) => srv.OwnerUserId == userId;

    public static async Task<bool> HasPlatformOwnerPowersAsync(
        IConfiguration? config,
        SloncordDbContext db,
        Guid userId,
        CancellationToken ct = default)
    {
        if (config is null) return false;
        return await SloncordPlatformPermissions.HasModeratorPrivilegesAsync(config, db, userId, ct);
    }

    public static async Task<bool> IsEffectiveServerOwnerAsync(
        SloncordDbContext db,
        ServerEntity srv,
        Guid userId,
        IConfiguration? config = null,
        CancellationToken ct = default)
    {
        if (IsServerOwner(srv, userId)) return true;
        return await HasPlatformOwnerPowersAsync(config, db, userId, ct);
    }

    public static async Task<bool> IsServerAdminAsync(SloncordDbContext db, Guid serverId, Guid userId, CancellationToken ct = default)
    {
        try
        {
            var sm = await db.ServerMembers.AsNoTracking()
                .FirstOrDefaultAsync(m => m.ServerId == serverId && m.UserId == userId, ct);
            return sm?.IsAdmin == true;
        }
        catch
        {
            return false;
        }
    }

    public static async Task<bool> CanModerateServerAsync(
        SloncordDbContext db,
        Guid serverId,
        Guid userId,
        IConfiguration? config = null,
        CancellationToken ct = default)
    {
        if (await HasPlatformOwnerPowersAsync(config, db, userId, ct)) return true;
        var srv = await GetServerAsync(db, serverId, ct);
        if (srv is null) return false;
        if (IsServerOwner(srv, userId)) return true;
        return await IsServerAdminAsync(db, serverId, userId, ct);
    }

    public static async Task<bool> CanManageChannelAsync(
        SloncordDbContext db,
        ChannelEntity ch,
        Guid userId,
        IConfiguration? config = null,
        CancellationToken ct = default)
    {
        if (await HasPlatformOwnerPowersAsync(config, db, userId, ct)) return true;
        if (ch.OwnerUserId == userId) return true;
        if (ch.ServerId is null) return false;
        var srv = await GetServerAsync(db, ch.ServerId.Value, ct);
        if (srv is not null && IsServerOwner(srv, userId)) return true;
        return srv is not null && await IsServerAdminAsync(db, srv.Id, userId, ct);
    }

    public static async Task<bool> CanManagePrivateChannelMembersAsync(
        SloncordDbContext db,
        ChannelEntity ch,
        Guid userId,
        IConfiguration? config = null,
        CancellationToken ct = default)
        => await CanManageChannelAsync(db, ch, userId, config, ct);

    public static async Task<bool> CanModerateServerMessagesAsync(
        SloncordDbContext db,
        Guid channelId,
        Guid userId,
        IConfiguration? config = null,
        CancellationToken ct = default)
    {
        var serverId = await db.Channels.AsNoTracking()
            .Where(c => c.Id == channelId)
            .Select(c => c.ServerId)
            .FirstOrDefaultAsync(ct);
        if (serverId is null) return false;
        return await CanModerateServerAsync(db, serverId.Value, userId, config, ct);
    }

    public static async Task<bool> IsBannedAsync(SloncordDbContext db, Guid serverId, Guid userId, CancellationToken ct = default)
    {
        try
        {
            return await db.ServerBans.AsNoTracking()
                .AnyAsync(b => b.ServerId == serverId && b.UserId == userId, ct);
        }
        catch
        {
            return false;
        }
    }

    public static async Task<List<string>> GetAdminUserIdsAsync(SloncordDbContext db, Guid serverId, CancellationToken ct = default)
    {
        try
        {
            return await db.ServerMembers.AsNoTracking()
                .Where(m => m.ServerId == serverId && m.IsAdmin)
                .Select(m => m.UserId.ToString("D"))
                .ToListAsync(ct);
        }
        catch
        {
            return new List<string>();
        }
    }
}
