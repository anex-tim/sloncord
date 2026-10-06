using Microsoft.EntityFrameworkCore;
using Sloncord.Data;
using Sloncord.Hubs;

namespace Sloncord.Services;

internal static class SystemMessageHelpers
{
    public static async Task CreateSystemMessageAsync(
        IDbContextFactory<SloncordDbContext> dbFactory,
        SloncordRealtime rt,
        Guid channelId,
        string text,
        CancellationToken ct)
    {
        await using var db = await dbFactory.CreateDbContextAsync(ct);
        var now = DateTime.UtcNow;

        var msg = new MessageEntity
        {
            Id = Guid.NewGuid(),
            ChannelId = channelId,
            SenderUserId = SloncordServerDataMigration.SystemUserId,
            Text = text ?? string.Empty,
            CreatedAtUtc = now,
            IsDeleted = false
        };
        db.Messages.Add(msg);
        await db.SaveChangesAsync(ct);

        // Minimal DTO shape consistent with ToMessageDtoAsync for plain text messages.
        object dto;
        try
        {
            var sender = await db.Users.AsNoTracking()
                .Where(u => u.Id == msg.SenderUserId)
                .Select(u => new { u.Nickname, u.AvatarFileId })
                .FirstOrDefaultAsync(ct);

            dto = new
            {
                id = msg.Id.ToString("D"),
                channelId = msg.ChannelId.ToString("D"),
                text = msg.Text,
                createdAtUtc = msg.CreatedAtUtc,
                editedAtUtc = (DateTime?)null,
                replyToMessageId = (string?)null,
                replyTo = (object?)null,
                senderUserId = msg.SenderUserId.ToString("D"),
                senderNickname = sender?.Nickname ?? "Sloncord",
                senderAvatarFileId = sender?.AvatarFileId?.ToString("D"),
                isDeleted = false,
                file = (object?)null,
                attachments = Array.Empty<object>()
            };
        }
        catch
        {
            dto = new
            {
                id = msg.Id.ToString("D"),
                channelId = msg.ChannelId.ToString("D"),
                text = msg.Text,
                createdAtUtc = msg.CreatedAtUtc,
                editedAtUtc = (DateTime?)null,
                replyToMessageId = (string?)null,
                replyTo = (object?)null,
                senderUserId = msg.SenderUserId.ToString("D"),
                senderNickname = "Sloncord",
                senderAvatarFileId = (string?)null,
                isDeleted = false,
                file = (object?)null,
                attachments = Array.Empty<object>()
            };
        }

        try
        {
            await rt.ToChannelAsync(channelId, SloncordHubEvents.MessageCreated, new
            {
                channelId = channelId.ToString("D"),
                message = dto
            });
        }
        catch
        {
            // best-effort
        }
    }
}

