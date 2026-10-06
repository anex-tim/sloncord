using Sloncord.Hubs;

namespace Sloncord;

internal static class SloncordSessions
{
    public static async Task NotifyRevokedAsync(SloncordAppState s, Guid userId)
    {
        try
        {
            await s.Realtime.ToUserAsync(userId, SloncordHubEvents.SessionsRevoked, new { ok = true });
        }
        catch
        {
            // best-effort
        }
    }
}
