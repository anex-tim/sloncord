using System.Collections.Concurrent;
using Microsoft.EntityFrameworkCore;
using Sloncord.Data;
using Sloncord.Hubs;

namespace Sloncord.Services;

internal sealed class DmCallManager
{
    private sealed record CallState(
        Guid ChannelId,
        Guid CallId,
        Guid FromUserId,
        Guid ToUserId,
        DateTime StartedAtUtc,
        DateTime? AcceptedAtUtc,
        DateTime? EndedAtUtc,
        string Status, // ringing | accepted | declined | cancelled | missed | ended
        CancellationTokenSource? TimeoutCts);

    private readonly ConcurrentDictionary<string, CallState> _calls = new();
    private readonly IDbContextFactory<SloncordDbContext> _dbFactory;
    private readonly SloncordRealtime _rt;

    public DmCallManager(IDbContextFactory<SloncordDbContext> dbFactory, SloncordRealtime rt)
    {
        _dbFactory = dbFactory;
        _rt = rt;
    }

    private static string Key(Guid channelId, Guid callId) => $"{channelId:N}:{callId:N}";

    public void RegisterRingingCall(Guid channelId, Guid callId, Guid fromUserId, Guid toUserId, DateTime startedAtUtc)
    {
        var k = Key(channelId, callId);
        var cts = new CancellationTokenSource();
        var st = new CallState(channelId, callId, fromUserId, toUserId, startedAtUtc, null, null, "ringing", cts);
        _calls[k] = st;
        _ = RunTimeoutAsync(st, cts.Token);
    }

    public void Cancel(Guid channelId, Guid callId)
    {
        var k = Key(channelId, callId);
        if (_calls.TryGetValue(k, out var st))
        {
            try { st.TimeoutCts?.Cancel(); } catch { /* ignore */ }
            _calls[k] = st with { Status = "cancelled", TimeoutCts = null };
        }
    }

    public bool TryCancelRinging(Guid channelId, Guid callId, out Guid fromUserId, out Guid toUserId)
    {
        fromUserId = Guid.Empty;
        toUserId = Guid.Empty;
        var k = Key(channelId, callId);
        if (!_calls.TryGetValue(k, out var st)) return false;
        fromUserId = st.FromUserId;
        toUserId = st.ToUserId;
        if (st.Status != "ringing") return false;
        try { st.TimeoutCts?.Cancel(); } catch { /* ignore */ }
        _calls[k] = st with { Status = "cancelled", TimeoutCts = null };
        return true;
    }

    public DateTime? MarkAccepted(Guid channelId, Guid callId, DateTime acceptedAtUtc)
    {
        var k = Key(channelId, callId);
        if (!_calls.TryGetValue(k, out var st)) return null;
        try { st.TimeoutCts?.Cancel(); } catch { /* ignore */ }
        var next = st with { Status = "accepted", AcceptedAtUtc = acceptedAtUtc, TimeoutCts = null };
        _calls[k] = next;
        return acceptedAtUtc;
    }

    public async Task EndAcceptedCallAsync(Guid channelId, Guid callId, DateTime endedAtUtc, CancellationToken ct)
    {
        var k = Key(channelId, callId);
        if (!_calls.TryGetValue(k, out var st)) return;
        if (st.Status != "accepted") return;
        if (st.EndedAtUtc is not null) return;

        var next = st with { Status = "ended", EndedAtUtc = endedAtUtc };
        _calls[k] = next;

        var start = next.AcceptedAtUtc ?? next.StartedAtUtc;
        var dur = endedAtUtc - start;
        if (dur < TimeSpan.Zero) dur = TimeSpan.Zero;
        var durText = dur.TotalHours >= 1
            ? $"{(int)dur.TotalHours:00}:{dur.Minutes:00}:{dur.Seconds:00}"
            : $"{dur.Minutes:00}:{dur.Seconds:00}";

        await SystemMessageHelpers.CreateSystemMessageAsync(
            _dbFactory,
            _rt,
            channelId,
            $"📞 Звонок завершён. Длительность: {durText}",
            ct);

        // Notify both sides to close/leave the call UI and voice session.
        var payload = new
        {
            callId = callId.ToString("D"),
            channelId = channelId.ToString("D"),
            reason = "ended"
        };
        try { await _rt.ToUserAsync(st.FromUserId, SloncordHubEvents.DmCallCancelled, payload); } catch { /* ignore */ }
        try { await _rt.ToUserAsync(st.ToUserId, SloncordHubEvents.DmCallCancelled, payload); } catch { /* ignore */ }
    }

    private async Task RunTimeoutAsync(CallState st, CancellationToken ct)
    {
        try
        {
            await Task.Delay(TimeSpan.FromSeconds(30), ct);
        }
        catch
        {
            return;
        }

        var k = Key(st.ChannelId, st.CallId);
        if (!_calls.TryGetValue(k, out var cur)) return;
        if (cur.Status != "ringing") return;

        _calls[k] = cur with { Status = "missed", TimeoutCts = null };

        // Notify both sides to close ringing UI.
        var payload = new
        {
            callId = st.CallId.ToString("D"),
            channelId = st.ChannelId.ToString("D"),
            reason = "timeout"
        };
        try { await _rt.ToUserAsync(st.FromUserId, SloncordHubEvents.DmCallCancelled, payload); } catch { /* ignore */ }
        try { await _rt.ToUserAsync(st.ToUserId, SloncordHubEvents.DmCallCancelled, payload); } catch { /* ignore */ }

        // System message in the DM chat.
        var fromNick = "пользователь";
        try
        {
            await using var db = await _dbFactory.CreateDbContextAsync(CancellationToken.None);
            var n = await db.Users.AsNoTracking()
                .Where(u => u.Id == st.FromUserId)
                .Select(u => u.Nickname)
                .FirstOrDefaultAsync();
            if (!string.IsNullOrWhiteSpace(n)) fromNick = n!;
        }
        catch { /* ignore */ }
        await SystemMessageHelpers.CreateSystemMessageAsync(
            _dbFactory,
            _rt,
            st.ChannelId,
            $"Пропущенный звонок от {fromNick}",
            CancellationToken.None);
    }
}

