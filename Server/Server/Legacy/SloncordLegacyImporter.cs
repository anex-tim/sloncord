using System.Text.Json;
using Microsoft.EntityFrameworkCore;
using Sloncord.Data;

namespace Sloncord;

internal static class SloncordLegacyImporter
{
    public static async Task TryImportFromJsonIfEmptyAsync(SloncordDbContext db, string dataDir)
    {
        if (await db.Users.AnyAsync()) return;
        if (!Directory.Exists(dataDir)) return;

        var usersPath = Path.Combine(dataDir, "users.json");
        if (!File.Exists(usersPath)) return;

        var users = await ReadJsonAsync<List<LegacyUser>>(usersPath) ?? new();
        var channels = await ReadJsonAsync<List<LegacyChannel>>(Path.Combine(dataDir, "channels.json")) ?? new();
        var files = await ReadJsonAsync<List<LegacyFile>>(Path.Combine(dataDir, "files.json")) ?? new();
        var messages = await ReadJsonAsync<List<LegacyMessage>>(Path.Combine(dataDir, "messages.json")) ?? new();
        if (users.Count == 0) return;

        await using var tx = await db.Database.BeginTransactionAsync();

        var storageDst = Path.Combine(dataDir, "storage");
        Directory.CreateDirectory(storageDst);

        foreach (var f in files)
        {
            db.Files.Add(new StoredFileEntity
            {
                Id = f.Id,
                OriginalName = f.OriginalName,
                ContentType = f.ContentType,
                SizeBytes = f.SizeBytes,
                StorageName = f.StorageName,
                UploadedByUserId = f.UploadedByUserId,
                UploadedAtUtc = f.UploadedAtUtc
            });
        }

        foreach (var u in users)
        {
            db.Users.Add(new UserEntity
            {
                Id = u.Id,
                Login = u.Login,
                PasswordHash = u.PasswordHash,
                Salt = u.Salt,
                Nickname = u.Nickname,
                Bio = u.Bio ?? string.Empty,
                CreatedAtUtc = u.CreatedAtUtc
            });
        }

        foreach (var c in channels)
        {
            var ent = new ChannelEntity
            {
                Id = c.Id,
                Name = c.Name,
                Kind = ChannelKindEntity.Public,
                OwnerUserId = c.OwnerUserId,
                CreatedAtUtc = c.CreatedAtUtc,
                Members = new List<ChannelMemberEntity>()
            };

            foreach (var m in c.MemberUserIds)
            {
                ent.Members!.Add(new ChannelMemberEntity
                {
                    UserId = m,
                    ChannelId = c.Id,
                    JoinedAtUtc = c.CreatedAtUtc
                });
            }
            db.Channels.Add(ent);
        }

        foreach (var m in messages)
        {
            db.Messages.Add(new MessageEntity
            {
                Id = m.Id,
                ChannelId = m.ChannelId,
                SenderUserId = m.SenderUserId,
                Text = m.Text ?? string.Empty,
                FileId = m.FileId,
                CreatedAtUtc = m.CreatedAtUtc,
                IsDeleted = false
            });
        }

        await db.SaveChangesAsync();
        await tx.CommitAsync();
    }

    private static async Task<T?> ReadJsonAsync<T>(string path)
    {
        if (!File.Exists(path)) return default;
        await using var stream = File.OpenRead(path);
        return await JsonSerializer.DeserializeAsync<T>(stream, SloncordJson.Options);
    }

    private sealed class LegacyUser
    {
        public Guid Id { get; set; }
        public string Login { get; set; } = string.Empty;
        public string PasswordHash { get; set; } = string.Empty;
        public string Salt { get; set; } = string.Empty;
        public string Nickname { get; set; } = string.Empty;
        public string? Bio { get; set; }
        public DateTime CreatedAtUtc { get; set; }
    }

    private sealed class LegacyChannel
    {
        public Guid Id { get; set; }
        public string Name { get; set; } = string.Empty;
        public Guid OwnerUserId { get; set; }
        public List<Guid> MemberUserIds { get; set; } = new();
        public DateTime CreatedAtUtc { get; set; }
    }

    private sealed class LegacyFile
    {
        public Guid Id { get; set; }
        public string OriginalName { get; set; } = string.Empty;
        public string ContentType { get; set; } = "application/octet-stream";
        public long SizeBytes { get; set; }
        public string StorageName { get; set; } = string.Empty;
        public Guid UploadedByUserId { get; set; }
        public DateTime UploadedAtUtc { get; set; }
    }

    private sealed class LegacyMessage
    {
        public Guid Id { get; set; }
        public Guid ChannelId { get; set; }
        public Guid SenderUserId { get; set; }
        public string? Text { get; set; }
        public Guid? FileId { get; set; }
        public DateTime CreatedAtUtc { get; set; }
    }
}
