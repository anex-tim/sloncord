using Microsoft.EntityFrameworkCore;
using Sloncord.Data;

namespace Sloncord;

/// <summary>Присваивает каждому старому публичному/голосовому каналу отдельный «сервер» и копирует состав участников.</summary>
internal static class SloncordServerDataMigration
{
    public static readonly Guid SystemUserId = Guid.Parse("00000000-0000-0000-0000-000000000001");

    public static async Task RunAsync(SloncordDbContext db, CancellationToken ct = default)
    {
        await EnsureSystemUserAsync(db, ct);

        if (!await db.Channels.AnyAsync(
                c => (c.Kind == ChannelKindEntity.Public || c.Kind == ChannelKindEntity.Voice) && c.ServerId == null,
                ct))
            return;

        var toFix = await db.Channels
            .Include(c => c.Members)
            .Where(c => (c.Kind == ChannelKindEntity.Public || c.Kind == ChannelKindEntity.Voice) && c.ServerId == null)
            .ToListAsync(ct);

        foreach (var ch in toFix)
        {
            if (ch.Members is null || ch.Members.Count == 0) continue;

            var code = NewInviteCode();
            var s = new ServerEntity
            {
                Id = Guid.NewGuid(),
                Name = ch.Name,
                OwnerUserId = ch.OwnerUserId,
                InviteCode = code,
                CreatedAtUtc = DateTime.UtcNow
            };
            db.Servers.Add(s);

            foreach (var m in ch.Members)
            {
                if (!await db.ServerMembers.AnyAsync(
                        x => x.ServerId == s.Id && x.UserId == m.UserId, ct))
                {
                    db.ServerMembers.Add(new ServerMemberEntity
                    {
                        ServerId = s.Id,
                        UserId = m.UserId,
                        JoinedAtUtc = m.JoinedAtUtc
                    });
                }
            }

            ch.ServerId = s.Id;
        }

        await db.SaveChangesAsync(ct);
    }

    private static async Task EnsureSystemUserAsync(SloncordDbContext db, CancellationToken ct)
    {
        // Create a dedicated user for system messages (missed/ended calls, etc.).
        // Avoids schema changes and keeps message DTOs consistent.
        if (await db.Users.AnyAsync(u => u.Id == SystemUserId, ct))
            return;

        // If someone already created a user with the same login/nickname, just reuse that user id to avoid unique index conflicts.
        var existing = await db.Users
            .FirstOrDefaultAsync(u => u.Login.ToLower() == "__system".ToLower() || u.Nickname.ToLower() == "sloncord".ToLower(), ct);
        if (existing is not null)
            return;

        db.Users.Add(new UserEntity
        {
            Id = SystemUserId,
            Login = "__system",
            Nickname = "Sloncord",
            PasswordHash = "!",
            Salt = "!",
            Bio = "system",
            CreatedAtUtc = DateTime.UtcNow
        });
        await db.SaveChangesAsync(ct);
    }

    public static string NewInviteCode() =>
        Convert.ToHexString(System.Security.Cryptography.RandomNumberGenerator.GetBytes(6)).ToLowerInvariant();
}
