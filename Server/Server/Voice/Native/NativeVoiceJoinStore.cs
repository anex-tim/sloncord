using System.Collections.Concurrent;
using System.Security.Cryptography;

namespace Sloncord.Voice.Native;

internal sealed class NativeVoiceJoinStore
{
    private sealed record Entry(Guid UserId, string RoomId, DateTime ExpiresAtUtc);

    private readonly ConcurrentDictionary<string, Entry> _byToken = new(StringComparer.Ordinal);

    public (string TokenHex, DateTime ExpiresAtUtc) Issue(Guid userId, string roomId, TimeSpan ttl)
    {
        var tokenBytes = RandomNumberGenerator.GetBytes(32);
        var tokenHex = Convert.ToHexString(tokenBytes).ToLowerInvariant();
        var expires = DateTime.UtcNow.Add(ttl);
        _byToken[tokenHex] = new Entry(userId, roomId, expires);
        return (tokenHex, expires);
    }

    public bool TryConsume(string tokenHex, out Guid userId, out string roomId)
    {
        userId = default;
        roomId = "";
        if (string.IsNullOrWhiteSpace(tokenHex)) return false;
        var key = tokenHex.Trim().ToLowerInvariant();
        if (!_byToken.TryGetValue(key, out var entry)) return false;
        if (entry.ExpiresAtUtc <= DateTime.UtcNow)
        {
            _byToken.TryRemove(key, out _);
            return false;
        }

        userId = entry.UserId;
        roomId = entry.RoomId;
        return true;
    }

    public void RevokeForUserRoom(Guid userId, string roomId)
    {
        foreach (var kv in _byToken)
        {
            if (kv.Value.UserId == userId && string.Equals(kv.Value.RoomId, roomId, StringComparison.OrdinalIgnoreCase))
                _byToken.TryRemove(kv.Key, out _);
        }
    }

    public void PurgeExpired()
    {
        var now = DateTime.UtcNow;
        foreach (var kv in _byToken)
        {
            if (kv.Value.ExpiresAtUtc <= now)
                _byToken.TryRemove(kv.Key, out _);
        }
    }
}
