namespace Sloncord.Voice;

/// <summary>
/// Keeps voice intent during brief disconnects so roster does not flicker.
/// </summary>
internal sealed class VoiceSessionRegistry
{
    private readonly object _sync = new();
    private readonly Dictionary<string, CancellationTokenSource> _graceTimers = new(StringComparer.OrdinalIgnoreCase);
    private readonly int _graceSeconds;

    public VoiceSessionRegistry(IConfiguration cfg)
    {
        _graceSeconds = SfuTokenHelper.ReadGraceSeconds(cfg);
    }

    public int GraceSeconds => _graceSeconds;

    private static string Key(string roomId, Guid userId) => $"{roomId.Trim()}:{userId:D}";

    public void CancelGrace(string roomId, Guid userId)
    {
        var key = Key(roomId, userId);
        lock (_sync)
        {
            if (!_graceTimers.TryGetValue(key, out var cts)) return;
            _graceTimers.Remove(key);
            try { cts.Cancel(); } catch { /* ignore */ }
            try { cts.Dispose(); } catch { /* ignore */ }
        }
    }

    /// <summary>
    /// Schedules roster grace. Returns true when grace is active and user should stay in room.
    /// </summary>
    public bool IsInGrace(string roomId, Guid userId)
    {
        var key = Key(roomId, userId);
        lock (_sync)
            return _graceTimers.ContainsKey(key);
    }

    public bool TryScheduleGrace(string roomId, Guid userId, Action onExpire)
    {
        if (_graceSeconds <= 0) return false;

        var key = Key(roomId, userId);
        CancellationTokenSource cts;
        lock (_sync)
        {
            if (_graceTimers.TryGetValue(key, out var prev))
            {
                try { prev.Cancel(); } catch { /* ignore */ }
                try { prev.Dispose(); } catch { /* ignore */ }
            }
            cts = new CancellationTokenSource();
            _graceTimers[key] = cts;
        }

        _ = Task.Run(async () =>
        {
            try
            {
                await Task.Delay(TimeSpan.FromSeconds(_graceSeconds), cts.Token);
                lock (_sync)
                {
                    if (_graceTimers.TryGetValue(key, out var cur) && ReferenceEquals(cur, cts))
                        _graceTimers.Remove(key);
                }
                onExpire();
            }
            catch (OperationCanceledException)
            {
                // reconnected in time
            }
            finally
            {
                try { cts.Dispose(); } catch { /* ignore */ }
            }
        });

        return true;
    }
}
