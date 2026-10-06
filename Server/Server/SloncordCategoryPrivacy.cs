using Microsoft.EntityFrameworkCore;
using Sloncord.Data;

namespace Sloncord;

internal static class SloncordCategoryPrivacy
{
    internal static async Task<List<Guid>> GetCategoryMemberIdsAsync(
        SloncordDbContext db,
        ChannelCategoryEntity cat,
        CancellationToken ct = default)
    {
        if (cat.IsPrivate)
        {
            return await db.CategoryMembers.AsNoTracking()
                .Where(m => m.CategoryId == cat.Id)
                .Select(m => m.UserId)
                .ToListAsync(ct);
        }

        return await db.ServerMembers.AsNoTracking()
            .Where(m => m.ServerId == cat.ServerId)
            .Select(m => m.UserId)
            .ToListAsync(ct);
    }

    internal static async Task SyncCategoryChildChannelsAsync(
        SloncordDbContext db,
        Guid categoryId,
        CancellationToken ct = default)
    {
        var cat = await db.ChannelCategories
            .Include(c => c.Channels)
            .FirstOrDefaultAsync(c => c.Id == categoryId, ct);
        if (cat is null) return;

        var memberIds = await GetCategoryMemberIdsAsync(db, cat, ct);
        var memberSet = memberIds.ToHashSet();

        foreach (var ch in cat.Channels ?? [])
        {
            ch.IsPrivate = cat.IsPrivate;
            var existing = await db.ChannelMembers
                .Where(m => m.ChannelId == ch.Id)
                .ToListAsync(ct);

            foreach (var m in existing)
            {
                if (m.IsVoiceOnly) continue;
                if (!memberSet.Contains(m.UserId))
                    db.ChannelMembers.Remove(m);
            }

            var have = existing.Select(m => m.UserId).ToHashSet();
            foreach (var uid in memberSet)
            {
                if (have.Contains(uid)) continue;
                db.ChannelMembers.Add(new ChannelMemberEntity
                {
                    ChannelId = ch.Id,
                    UserId = uid,
                    JoinedAtUtc = DateTime.UtcNow
                });
            }
        }

        await db.SaveChangesAsync(ct);
    }

    internal static async Task ApplyChannelCategoryPrivacyAsync(
        SloncordDbContext db,
        ChannelEntity ch,
        CancellationToken ct = default)
    {
        if (ch.CategoryId is null)
        {
            return;
        }

        var cat = await db.ChannelCategories.AsNoTracking()
            .FirstOrDefaultAsync(c => c.Id == ch.CategoryId, ct);
        if (cat is null || !cat.IsPrivate) return;

        ch.IsPrivate = true;
        var memberIds = await GetCategoryMemberIdsAsync(db, cat, ct);
        var memberSet = memberIds.ToHashSet();
        var existing = await db.ChannelMembers
            .Where(m => m.ChannelId == ch.Id)
            .ToListAsync(ct);

        foreach (var m in existing.Where(m => !m.IsVoiceOnly && !memberSet.Contains(m.UserId)))
            db.ChannelMembers.Remove(m);

        var have = existing.Select(m => m.UserId).ToHashSet();
        foreach (var uid in memberSet)
        {
            if (have.Contains(uid)) continue;
            db.ChannelMembers.Add(new ChannelMemberEntity
            {
                ChannelId = ch.Id,
                UserId = uid,
                JoinedAtUtc = DateTime.UtcNow
            });
        }

        await db.SaveChangesAsync(ct);
    }

    internal static async Task SetCategoryPrivateAsync(
        SloncordDbContext db,
        ChannelCategoryEntity cat,
        bool isPrivate,
        Guid actorUserId,
        CancellationToken ct = default)
    {
        cat.IsPrivate = isPrivate;

        if (isPrivate)
        {
            if (!await db.CategoryMembers.AnyAsync(m => m.CategoryId == cat.Id && m.UserId == actorUserId, ct))
            {
                db.CategoryMembers.Add(new CategoryMemberEntity
                {
                    CategoryId = cat.Id,
                    UserId = actorUserId,
                    JoinedAtUtc = DateTime.UtcNow
                });
            }
        }

        await db.SaveChangesAsync(ct);
        await SyncCategoryChildChannelsAsync(db, cat.Id, ct);
    }
}
