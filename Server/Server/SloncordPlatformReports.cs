using Microsoft.EntityFrameworkCore;
using Sloncord.Data;
using Sloncord.Hubs;

namespace Sloncord;

internal static class SloncordPlatformReports
{
    public static Task<int> CountPendingAsync(SloncordDbContext db, CancellationToken ct = default) =>
        db.MessageReports.AsNoTracking().CountAsync(r => r.Status == "pending", ct);

    public static async Task NotifyChangedAsync(SloncordAppState s, SloncordDbContext db, CancellationToken ct = default)
    {
        try
        {
            var pendingCount = await CountPendingAsync(db, ct);
            await s.Realtime.ToPlatformModeratorsAsync(SloncordHubEvents.PlatformReportsChanged, new { pendingCount });
        }
        catch
        {
            // best-effort
        }
    }
}
