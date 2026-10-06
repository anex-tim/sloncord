using Microsoft.EntityFrameworkCore;
using Sloncord.Data;
using Sloncord.Hubs;

namespace Sloncord;

internal static class SloncordPlatformPermissions
{
    public static HashSet<string> ReadModeratorLogins(IConfiguration config)
    {
        var set = new HashSet<string>(StringComparer.OrdinalIgnoreCase);

        var fromEnv = Environment.GetEnvironmentVariable("SLONCORD_MODERATOR_LOGINS");
        if (!string.IsNullOrWhiteSpace(fromEnv))
        {
            foreach (var part in fromEnv.Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries))
            {
                if (!string.IsNullOrWhiteSpace(part)) set.Add(part.Trim());
            }
        }

        var section = config.GetSection("Sloncord:Moderation:ModeratorLogins");
        foreach (var child in section.GetChildren())
        {
            var v = child.Value?.Trim();
            if (!string.IsNullOrWhiteSpace(v)) set.Add(v);
        }

        return set;
    }

    public static bool IsModeratorLogin(IConfiguration config, string login)
    {
        if (string.IsNullOrWhiteSpace(login)) return false;
        return ReadModeratorLogins(config).Contains(login.Trim());
    }

    public static bool IsPlatformRoot(string? login) => SloncordPlatformModeratorPerms.IsRootLogin(login);

    public static (bool IsRoot, bool IsModerator, bool IsTeam) GetPublicTeamFlags(
        UserEntity u,
        IConfiguration? config = null)
    {
        var isRoot = IsPlatformRoot(u.Login);
        if (isRoot) return (true, false, true);
        var isMod = u.IsPlatformModerator
            || (config is not null && IsModeratorLogin(config, u.Login));
        return (false, isMod, isMod);
    }

    public static async Task<ulong> GetEffectivePermissionsAsync(
        IConfiguration config,
        SloncordDbContext db,
        Guid userId,
        CancellationToken ct = default)
    {
        var user = await db.Users.AsNoTracking()
            .Where(u => u.Id == userId)
            .Select(u => new { u.Login, u.IsPlatformModerator, u.PlatformModeratorPermissions })
            .FirstOrDefaultAsync(ct);
        if (user is null) return 0;
        if (IsPlatformRoot(user.Login) || IsModeratorLogin(config, user.Login))
            return SloncordPlatformModeratorPerms.All;
        if (!user.IsPlatformModerator) return 0;
        return user.PlatformModeratorPermissions;
    }

    public static async Task<bool> HasPermissionAsync(
        IConfiguration config,
        SloncordDbContext db,
        Guid userId,
        PlatformModeratorPerm perm,
        CancellationToken ct = default)
    {
        var mask = await GetEffectivePermissionsAsync(config, db, userId, ct);
        return SloncordPlatformModeratorPerms.Has(mask, perm);
    }

    public static async Task<bool> HasAnyModerationAccessAsync(
        IConfiguration config,
        SloncordDbContext db,
        Guid userId,
        CancellationToken ct = default)
    {
        var user = await db.Users.AsNoTracking()
            .Where(u => u.Id == userId)
            .Select(u => new { u.Login, u.IsPlatformModerator, u.PlatformModeratorPermissions })
            .FirstOrDefaultAsync(ct);
        if (user is null) return false;
        if (IsPlatformRoot(user.Login) || IsModeratorLogin(config, user.Login)) return true;
        return user.IsPlatformModerator && user.PlatformModeratorPermissions != 0;
    }

    public static async Task<bool> IsPlatformModeratorAsync(
        IConfiguration config,
        SloncordDbContext db,
        Guid userId,
        CancellationToken ct = default)
        => await HasAnyModerationAccessAsync(config, db, userId, ct);

    public static async Task<bool> HasModeratorPrivilegesAsync(
        IConfiguration config,
        SloncordDbContext db,
        Guid userId,
        CancellationToken ct = default)
    {
        var user = await db.Users.AsNoTracking()
            .Where(u => u.Id == userId)
            .Select(u => new { u.Login, u.IsPlatformModerator })
            .FirstOrDefaultAsync(ct);
        if (user is null) return false;
        if (IsPlatformRoot(user.Login) || IsModeratorLogin(config, user.Login)) return true;
        return user.IsPlatformModerator;
    }

    public static Task<bool> IsPlatformBannedAsync(SloncordDbContext db, Guid userId, CancellationToken ct = default)
        => SloncordPlatformBan.IsActiveAsync(db, userId, ct);

    public static Task BroadcastTeamFlagsChangedAsync(
        SloncordRealtime realtime,
        IConfiguration config,
        UserEntity user)
    {
        var (isRoot, isMod, isTeam) = GetPublicTeamFlags(user, config);
        return realtime.BroadcastAsync(SloncordHubEvents.UserTeamChanged, new
        {
            userId = user.Id.ToString("D"),
            isPlatformRoot = isRoot,
            isPlatformModerator = isMod,
            isSloncordTeam = isTeam,
        });
    }

    public static async Task<(bool Deny, string Error)> ShouldDenyModeratorActionOnRootAsync(
        SloncordDbContext db,
        Guid actorUserId,
        Guid targetUserId,
        CancellationToken ct = default)
    {
        if (targetUserId == Guid.Empty) return (false, "");
        var users = await db.Users.AsNoTracking()
            .Where(u => u.Id == actorUserId || u.Id == targetUserId)
            .Select(u => new { u.Id, u.Login })
            .ToListAsync(ct);
        var target = users.FirstOrDefault(u => u.Id == targetUserId);
        if (target is null || !IsPlatformRoot(target.Login)) return (false, "");
        var actor = users.FirstOrDefault(u => u.Id == actorUserId);
        if (actor is not null && IsPlatformRoot(actor.Login)) return (false, "");
        return (true, "Нельзя выполнять действия над root");
    }

    public static async Task<(bool Deny, string Error)> ShouldDenyModeratorActionOnRootMessageAsync(
        SloncordDbContext db,
        Guid actorUserId,
        Guid messageId,
        CancellationToken ct = default)
    {
        var senderId = await db.Messages.AsNoTracking()
            .Where(m => m.Id == messageId)
            .Select(m => (Guid?)m.SenderUserId)
            .FirstOrDefaultAsync(ct);
        if (senderId is null) return (false, "");
        return await ShouldDenyModeratorActionOnRootAsync(db, actorUserId, senderId.Value, ct);
    }
}
