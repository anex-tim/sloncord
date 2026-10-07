using System.Security.Cryptography;
using System.Text;
using Microsoft.EntityFrameworkCore;
using Sloncord.Data;

namespace Sloncord;

internal static class PasswordHasher
{
    private const int Pbkdf2Iterations = 100_000;

    public static string Hash(string password, string salt)
    {
        var bytes = Rfc2898DeriveBytes.Pbkdf2(
            Encoding.UTF8.GetBytes(password),
            Encoding.UTF8.GetBytes(salt),
            Pbkdf2Iterations,
            HashAlgorithmName.SHA256,
            32);
        return "pbkdf2$" + Convert.ToHexString(bytes);
    }

    public static bool IsLegacy(string stored) =>
        !stored.StartsWith("pbkdf2$", StringComparison.OrdinalIgnoreCase);

    public static bool Verify(string password, string salt, string stored)
    {
        if (string.IsNullOrEmpty(stored)) return false;
        if (!IsLegacy(stored))
        {
            var expect = Hash(password, salt);
            var a = Encoding.UTF8.GetBytes(expect);
            var b = Encoding.UTF8.GetBytes(stored);
            return a.Length == b.Length && CryptographicOperations.FixedTimeEquals(a, b);
        }

        var legacy = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(password + salt)));
        var la = Encoding.UTF8.GetBytes(legacy);
        var lb = Encoding.UTF8.GetBytes(stored.Trim());
        return la.Length == lb.Length && CryptographicOperations.FixedTimeEquals(la, lb);
    }
}

internal static class SloncordStoragePath
{
    public static string? ResolveInside(string root, string fileName)
    {
        if (string.IsNullOrWhiteSpace(root) || string.IsNullOrWhiteSpace(fileName)) return null;
        if (fileName.IndexOfAny(new[] { '/', '\\', ':' }) >= 0) return null;
        var rootFull = Path.GetFullPath(root);
        var full = Path.GetFullPath(Path.Combine(rootFull, fileName));
        var prefix = rootFull.EndsWith(Path.DirectorySeparatorChar)
            ? rootFull
            : rootFull + Path.DirectorySeparatorChar;
        if (!full.StartsWith(prefix, StringComparison.OrdinalIgnoreCase)) return null;
        return full;
    }
}

internal static class AuthRateLimiter
{
    private static readonly System.Collections.Concurrent.ConcurrentDictionary<string, Queue<DateTime>> Hits = new();

    public static bool Allow(string key, int max, TimeSpan window)
    {
        if (string.IsNullOrWhiteSpace(key)) return true;
        var now = DateTime.UtcNow;
        var q = Hits.GetOrAdd(key, _ => new Queue<DateTime>());
        lock (q)
        {
            while (q.Count > 0 && now - q.Peek() > window) q.Dequeue();
            if (q.Count >= max) return false;
            q.Enqueue(now);
            return true;
        }
    }
}

internal static class SloncordQueries
{
    public static async Task<DateTime?> GetDmClearedUpToUtcAsync(
        SloncordDbContext db, Guid userId, Guid channelId, CancellationToken ct = default)
    {
        var kind = await db.Channels.AsNoTracking()
            .Where(c => c.Id == channelId)
            .Select(c => c.Kind)
            .FirstOrDefaultAsync(ct);
        if (kind != ChannelKindEntity.Direct) return null;

        return await db.ChannelReadStates.AsNoTracking()
            .Where(x => x.UserId == userId && x.ChannelId == channelId)
            .Select(x => x.DmClearedUpToUtc)
            .FirstOrDefaultAsync(ct);
    }

    /// <summary>Текстовые (Public) и голосовые каналы гильдии.</summary>
    public static IQueryable<ChannelEntity> GuildChannelsForUser(SloncordDbContext db, Guid userId) =>
        db.Channels
            .AsNoTracking()
            .Where(c => (c.Kind == ChannelKindEntity.Public || c.Kind == ChannelKindEntity.Voice)
                && db.ChannelMembers.Any(m => m.ChannelId == c.Id && m.UserId == userId));

    public static IQueryable<ChannelEntity> DirectChannelsForUser(SloncordDbContext db, Guid userId) =>
        db.Channels
            .AsNoTracking()
            .Where(c => c.Kind == ChannelKindEntity.Direct
                && db.ChannelMembers.Any(m => m.ChannelId == c.Id && m.UserId == userId)
                && (
                    !db.ChannelReadStates.Any(rs => rs.UserId == userId && rs.ChannelId == c.Id && rs.DmClearedUpToUtc != null)
                    || db.Messages.Any(msg =>
                        msg.ChannelId == c.Id
                        && !msg.IsDeleted
                        && db.ChannelReadStates.Any(rs =>
                            rs.UserId == userId
                            && rs.ChannelId == c.Id
                            && rs.DmClearedUpToUtc != null
                            && msg.CreatedAtUtc > rs.DmClearedUpToUtc)
                    )
                ));

    public static async Task<ChannelEntity?> GetChannelForUserAsync(
        SloncordDbContext db, Guid channelId, Guid userId, CancellationToken ct = default) =>
        await db.Channels
            .Include(c => c.Members)
            .FirstOrDefaultAsync(c => c.Id == channelId
                && db.ChannelMembers.Any(m => m.ChannelId == c.Id && m.UserId == userId), ct);

    public static async Task<int> UnreadCountAsync(
        SloncordDbContext db, Guid userId, Guid channelId, CancellationToken ct = default)
    {
        var ch = await db.Channels.AsNoTracking()
            .Where(c => c.Id == channelId)
            .Select(c => new { c.Kind })
            .FirstOrDefaultAsync(ct);
        if (ch is null) return 0;

        var read = await db.ChannelReadStates
            .AsNoTracking()
            .FirstOrDefaultAsync(x => x.UserId == userId && x.ChannelId == channelId, ct);

        var lastRead = read?.LastReadMessageId;
        DateTime? clearedUpTo = ch.Kind == ChannelKindEntity.Direct ? read?.DmClearedUpToUtc : null;

        IQueryable<MessageEntity> q = db.Messages.AsNoTracking()
            .Where(m => m.ChannelId == channelId && !m.IsDeleted);

        if (clearedUpTo is not null)
        {
            // Strictly "after" boundary: deleting at time T should hide history up to and including the last messages.
            q = q.Where(m => m.CreatedAtUtc > clearedUpTo.Value);
        }

        if (lastRead is not null)
        {
            var marker = await db.Messages.AsNoTracking()
                .Where(m => m.Id == lastRead.Value)
                .Select(m => new { m.CreatedAtUtc })
                .FirstOrDefaultAsync(ct);

            if (marker is not null)
            {
                q = q.Where(m => m.CreatedAtUtc > marker.CreatedAtUtc);
            }
        }

        // Exclude self messages? Discord counts other people's messages. We'll only count not authored by the viewer.
        q = q.Where(m => m.SenderUserId != userId);

        return await q.CountAsync(ct);
    }
}
