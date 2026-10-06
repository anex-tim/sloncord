using Microsoft.EntityFrameworkCore;
using Sloncord.Data;

namespace Sloncord;

internal static class SloncordPlatformIpBan
{
    public static bool IsActive(PlatformIpBanEntity ban)
    {
        if (ban.BannedUntilUtc is null) return true;
        return ban.BannedUntilUtc.Value > DateTime.UtcNow;
    }

    public static async Task<bool> IsIpBannedAsync(SloncordDbContext db, string? ip, CancellationToken ct = default)
    {
        var norm = SloncordClientIp.Normalize(ip);
        if (string.IsNullOrWhiteSpace(norm)) return false;

        var bans = await db.PlatformIpBans.AsNoTracking()
            .Where(b => b.IpAddress == norm)
            .ToListAsync(ct);
        foreach (var ban in bans)
        {
            if (IsActive(ban)) return true;
        }
        return false;
    }

    public static void Apply(
        PlatformIpBanEntity ban,
        string ip,
        Guid actorUserId,
        string reason,
        int? durationMinutes)
    {
        ban.IpAddress = SloncordClientIp.Normalize(ip);
        ban.Reason = reason ?? "";
        ban.BannedByUserId = actorUserId;
        ban.BannedAtUtc = DateTime.UtcNow;
        ban.BannedUntilUtc = durationMinutes is > 0
            ? DateTime.UtcNow.AddMinutes(durationMinutes.Value)
            : null;
    }
}
