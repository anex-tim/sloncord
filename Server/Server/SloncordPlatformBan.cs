using Microsoft.AspNetCore.Http;
using Microsoft.EntityFrameworkCore;
using Sloncord.Data;
using Sloncord.Hubs;

namespace Sloncord;

internal static class SloncordPlatformBan
{
    public static bool IsActive(UserEntity u, DateTime? nowUtc = null)
    {
        nowUtc ??= DateTime.UtcNow;
        if (!u.IsPlatformBanned) return false;
        if (u.PlatformBannedUntilUtc is null) return true;
        return u.PlatformBannedUntilUtc.Value > nowUtc.Value;
    }

    public static void Apply(UserEntity u, Guid actorUserId, string reason, int? durationMinutes)
    {
        u.IsPlatformBanned = true;
        u.PlatformBannedAtUtc = DateTime.UtcNow;
        u.PlatformBanReason = (reason ?? "").Trim();
        u.PlatformBannedByUserId = actorUserId;
        u.PlatformBannedUntilUtc = durationMinutes is > 0
            ? DateTime.UtcNow.AddMinutes(durationMinutes.Value)
            : null;
    }

    public static void Clear(UserEntity u)
    {
        u.IsPlatformBanned = false;
        u.PlatformBannedAtUtc = null;
        u.PlatformBanReason = null;
        u.PlatformBannedByUserId = null;
        u.PlatformBannedUntilUtc = null;
    }

    public static async Task<bool> IsActiveAsync(SloncordDbContext db, Guid userId, CancellationToken ct = default)
    {
        var row = await db.Users.AsNoTracking()
            .Where(x => x.Id == userId)
            .Select(x => new { x.IsPlatformBanned, x.PlatformBannedUntilUtc })
            .FirstOrDefaultAsync(ct);
        if (row is null || !row.IsPlatformBanned) return false;
        if (row.PlatformBannedUntilUtc is null) return true;
        return row.PlatformBannedUntilUtc.Value > DateTime.UtcNow;
    }

    public static async Task TryExpireAsync(SloncordDbContext db, Guid userId, CancellationToken ct = default)
    {
        var u = await db.Users.FirstOrDefaultAsync(x => x.Id == userId, ct);
        if (u is null || !u.IsPlatformBanned) return;
        if (u.PlatformBannedUntilUtc is not null && u.PlatformBannedUntilUtc.Value <= DateTime.UtcNow)
        {
            Clear(u);
            await db.SaveChangesAsync(ct);
        }
    }

    public static IResult? LoginDenyIfBanned(UserEntity u)
    {
        if (!IsActive(u)) return null;
        return Results.Json(new
        {
            error = "Аккаунт заблокирован модерацией платформы",
            platformBanned = true,
            platformBanReason = u.PlatformBanReason ?? "",
            platformBannedUntilUtc = u.PlatformBannedUntilUtc?.ToString("O"),
            platformBanPermanent = u.PlatformBannedUntilUtc is null
        }, statusCode: StatusCodes.Status403Forbidden);
    }

    public static async Task NotifyBannedAsync(SloncordAppState s, Guid userId, string reason, DateTime? untilUtc)
    {
        try
        {
            await s.Realtime.ToUserAsync(userId, SloncordHubEvents.PlatformBanned, new
            {
                reason = reason ?? "",
                bannedUntilUtc = untilUtc?.ToString("O"),
                permanent = untilUtc is null
            });
        }
        catch
        {
            // best-effort
        }
    }
}
