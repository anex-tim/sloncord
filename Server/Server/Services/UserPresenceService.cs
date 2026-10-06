using System.Collections.Concurrent;

namespace Sloncord.Services;

/// <summary>
/// Tracks "online" users by active /ws/realtime connections.
/// </summary>
public sealed class UserPresenceService
{
    private readonly ConcurrentDictionary<Guid, int> _counts = new();
    private readonly ConcurrentDictionary<Guid, CancellationTokenSource> _offlineTimers = new();

    public bool IsOnline(Guid userId)
    {
        return _counts.TryGetValue(userId, out var c) && c > 0;
    }

    public void MarkOnline(Guid userId)
    {
        _counts.AddOrUpdate(userId, 1, (_, cur) => Math.Max(0, cur) + 1);
        CancelOfflineCountdown(userId);
    }

    public void MarkOffline(Guid userId)
    {
        _counts.AddOrUpdate(userId, 0, (_, cur) => Math.Max(0, cur - 1));
        // Do not remove immediately; hub will decide offline after grace period.
    }

    public int GetConnectionCount(Guid userId)
    {
        return _counts.TryGetValue(userId, out var c) ? c : 0;
    }

    public CancellationToken BeginOfflineCountdown(Guid userId)
    {
        CancelOfflineCountdown(userId);
        var cts = new CancellationTokenSource();
        _offlineTimers[userId] = cts;
        return cts.Token;
    }

    public void CancelOfflineCountdown(Guid userId)
    {
        if (_offlineTimers.TryRemove(userId, out var cts))
        {
            try { cts.Cancel(); } catch { /* ignore */ }
            try { cts.Dispose(); } catch { /* ignore */ }
        }
    }
}

