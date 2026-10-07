using System.Collections.Concurrent;
using System.Security.Cryptography;

namespace Sloncord;

/// <summary>
/// Короткий билет на один файл. В URL медиа попадает он, а не токен сессии.
/// </summary>
internal sealed class FileAccessTicketStore
{
    private readonly ConcurrentDictionary<string, Entry> _byToken = new(StringComparer.Ordinal);

    public (string Ticket, int ExpiresInSeconds) Issue(Guid userId, Guid fileId, TimeSpan ttl)
    {
        Purge();
        var seconds = (int)Math.Clamp(ttl.TotalSeconds, 30, 3600);
        var ticket = Convert.ToHexString(RandomNumberGenerator.GetBytes(24)).ToLowerInvariant();
        _byToken[ticket] = new Entry(userId, fileId, DateTime.UtcNow.AddSeconds(seconds));
        return (ticket, seconds);
    }

    public bool TryAuthorize(string? ticket, Guid fileId, out Guid userId)
    {
        userId = default;
        if (string.IsNullOrWhiteSpace(ticket)) return false;
        var key = ticket.Trim().ToLowerInvariant();
        if (!_byToken.TryGetValue(key, out var entry)) return false;
        if (entry.ExpiresAtUtc <= DateTime.UtcNow || entry.FileId != fileId)
        {
            if (entry.ExpiresAtUtc <= DateTime.UtcNow) _byToken.TryRemove(key, out _);
            return false;
        }

        userId = entry.UserId;
        return true;
    }

    private void Purge()
    {
        var now = DateTime.UtcNow;
        foreach (var kv in _byToken)
        {
            if (kv.Value.ExpiresAtUtc <= now)
                _byToken.TryRemove(kv.Key, out _);
        }
    }

    private readonly record struct Entry(Guid UserId, Guid FileId, DateTime ExpiresAtUtc);
}
