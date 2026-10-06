using Microsoft.AspNetCore.Http;
using Microsoft.EntityFrameworkCore;
using Sloncord.Data;
using Sloncord.Hubs;

namespace Sloncord;

internal static class SloncordChatMute
{
    public static bool IsActive(UserEntity u, DateTime? nowUtc = null)
    {
        nowUtc ??= DateTime.UtcNow;
        return u.ChatMutedUntilUtc is not null && u.ChatMutedUntilUtc.Value > nowUtc.Value;
    }

    public static bool IsActive(DateTime? untilUtc, DateTime? nowUtc = null)
    {
        nowUtc ??= DateTime.UtcNow;
        return untilUtc is not null && untilUtc.Value > nowUtc.Value;
    }

    public static void Apply(UserEntity u, Guid actorUserId, string reason, DateTime untilUtc)
    {
        u.ChatMutedUntilUtc = untilUtc;
        u.ChatMuteReason = (reason ?? "").Trim();
        u.ChatMutedByUserId = actorUserId;
    }

    public static void Clear(UserEntity u)
    {
        u.ChatMutedUntilUtc = null;
        u.ChatMuteReason = null;
        u.ChatMutedByUserId = null;
    }

    public static object? ChatMuteDto(UserEntity u)
    {
        if (!IsActive(u)) return null;
        return new
        {
            chatMuted = true,
            chatMuteReason = u.ChatMuteReason ?? "",
            chatMutedUntilUtc = u.ChatMutedUntilUtc!.Value.ToString("O")
        };
    }

    public static async Task<IResult?> DenyResultIfMutedAsync(SloncordDbContext db, Guid userId, CancellationToken ct = default)
    {
        var row = await db.Users.AsNoTracking()
            .Where(x => x.Id == userId)
            .Select(x => new { x.ChatMutedUntilUtc, x.ChatMuteReason })
            .FirstOrDefaultAsync(ct);
        if (row is null || !IsActive(row.ChatMutedUntilUtc)) return null;

        return Results.Json(new
        {
            error = "Чат временно заблокирован",
            chatMuted = true,
            chatMuteReason = row.ChatMuteReason ?? "",
            chatMutedUntilUtc = row.ChatMutedUntilUtc!.Value.ToString("O")
        }, statusCode: StatusCodes.Status403Forbidden);
    }

    public static async Task NotifyChangedAsync(
        SloncordAppState s,
        Guid userId,
        bool muted,
        string? reason = null,
        DateTime? untilUtc = null)
    {
        try
        {
            await s.Realtime.ToUserAsync(userId, SloncordHubEvents.ChatMuteChanged, new
            {
                muted,
                reason = reason ?? "",
                mutedUntilUtc = untilUtc?.ToString("O")
            });
        }
        catch
        {
            // best-effort
        }
    }
}
