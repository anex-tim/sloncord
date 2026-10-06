namespace Sloncord;

public sealed record ServerLogLine(
    DateTime CreatedAtUtc,
    string Level,
    string Category,
    string Message,
    string? Exception);

public sealed class SloncordServerLogStore
{
    private readonly string _logPath;
    private readonly object _lock = new();
    private readonly LinkedList<ServerLogLine> _ring = new();
    private const int MaxRing = 8000;

    public SloncordServerLogStore(string dataDir)
    {
        var logsDir = Path.Combine(dataDir, "logs");
        Directory.CreateDirectory(logsDir);
        _logPath = Path.Combine(logsDir, "sloncord.log");
    }

    public void Append(string level, string category, string message, Exception? ex = null)
    {
        var line = new ServerLogLine(
            DateTime.UtcNow,
            level,
            category,
            message,
            ex?.ToString());

        lock (_lock)
        {
            _ring.AddLast(line);
            while (_ring.Count > MaxRing) _ring.RemoveFirst();
            try
            {
                File.AppendAllText(_logPath, Format(line) + Environment.NewLine);
            }
            catch
            {
                // best-effort
            }
        }
    }

    public (List<ServerLogLine> Items, int Total) Query(int skip, int take, string? level, string? q)
    {
        lock (_lock)
        {
            IEnumerable<ServerLogLine> src = _ring.Reverse();
            var levelNorm = (level ?? "").Trim().ToLowerInvariant();
            if (levelNorm is "error" or "warning" or "information" or "info")
            {
                if (levelNorm == "info") levelNorm = "information";
                src = src.Where(x => x.Level.Equals(levelNorm, StringComparison.OrdinalIgnoreCase)
                    || (levelNorm == "information" && x.Level.Equals("info", StringComparison.OrdinalIgnoreCase)));
            }

            var term = (q ?? "").Trim();
            if (!string.IsNullOrWhiteSpace(term))
            {
                src = src.Where(x =>
                    x.Message.Contains(term, StringComparison.OrdinalIgnoreCase)
                    || x.Category.Contains(term, StringComparison.OrdinalIgnoreCase)
                    || (x.Exception?.Contains(term, StringComparison.OrdinalIgnoreCase) ?? false));
            }

            var list = src.ToList();
            var total = list.Count;
            var items = list.Skip(Math.Max(0, skip)).Take(Math.Clamp(take, 1, 500)).ToList();
            return (items, total);
        }
    }

    private static string Format(ServerLogLine line)
    {
        var ts = line.CreatedAtUtc.ToString("O");
        var baseLine = $"{ts}\t{line.Level.ToUpperInvariant()}\t{line.Category}\t{line.Message}";
        if (string.IsNullOrWhiteSpace(line.Exception)) return baseLine;
        return baseLine + Environment.NewLine + line.Exception;
    }
}

internal sealed class SloncordServerLoggerProvider : ILoggerProvider
{
    private readonly SloncordServerLogStore _store;

    public SloncordServerLoggerProvider(SloncordServerLogStore store) => _store = store;

    public ILogger CreateLogger(string categoryName) => new SloncordServerLogger(_store, categoryName);

    public void Dispose() { }
}

internal sealed class SloncordServerLogger : ILogger
{
    private readonly SloncordServerLogStore _store;
    private readonly string _category;

    public SloncordServerLogger(SloncordServerLogStore store, string category)
    {
        _store = store;
        _category = category;
    }

    public IDisposable? BeginScope<TState>(TState state) where TState : notnull => null;

    public bool IsEnabled(LogLevel logLevel) => logLevel >= LogLevel.Information;

    public void Log<TState>(
        LogLevel logLevel,
        EventId eventId,
        TState state,
        Exception? exception,
        Func<TState, Exception?, string> formatter)
    {
        if (!IsEnabled(logLevel)) return;
        if (logLevel < LogLevel.Warning
            && !_category.StartsWith("Sloncord", StringComparison.Ordinal)
            && !_category.StartsWith("Microsoft.AspNetCore.Hosting", StringComparison.Ordinal)
            && !_category.StartsWith("Microsoft.AspNetCore.Routing", StringComparison.Ordinal))
            return;

        var level = logLevel switch
        {
            LogLevel.Critical or LogLevel.Error => "error",
            LogLevel.Warning => "warning",
            _ => "information"
        };
        _store.Append(level, _category, formatter(state, exception), exception);
    }
}
