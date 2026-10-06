using System.Security.Cryptography;
using System.Text;
using Microsoft.EntityFrameworkCore;
using Sloncord.Data;

namespace Sloncord;

internal static class PasswordHasher
{
    public static string Hash(string password, string salt)
    {
        var bytes = SHA256.HashData(Encoding.UTF8.GetBytes(password + salt));
        return Convert.ToHexString(bytes);
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
