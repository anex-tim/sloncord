using Sloncord.Hubs;

namespace Sloncord;

internal static class SloncordSessions
{
    public static Task NotifyRevokedAsync(SloncordAppState s, Guid userId) =>
        NotifyAsync(s, userId, reason: null);

    public static Task NotifyApprovalRevokedAsync(SloncordAppState s, Guid userId) =>
        NotifyAsync(s, userId, reason: "approval_revoked");

    public static Task NotifyPasswordChangedAsync(SloncordAppState s, Guid userId) =>
        NotifyAsync(s, userId, reason: "password_changed");

    private static async Task NotifyAsync(SloncordAppState s, Guid userId, string? reason)
    {
        try
        {
            await s.Realtime.ToUserAsync(userId, SloncordHubEvents.SessionsRevoked, new { ok = true, reason });
        }
        catch
        {
            // best-effort
        }
    }
}
