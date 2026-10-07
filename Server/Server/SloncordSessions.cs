using Sloncord.Hubs;

namespace Sloncord;

internal static class SloncordSessions
{
    public static Task NotifyRevokedAsync(SloncordAppState s, Guid userId) =>
        NotifyAsync(s, userId, reason: null);

    public static Task NotifyApprovalRevokedAsync(SloncordAppState s, Guid userId) =>
        NotifyAsync(s, userId, reason: "approval_revoked");

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
