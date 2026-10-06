using Microsoft.EntityFrameworkCore;
using Sloncord.Data;

namespace Sloncord;

internal static class SloncordUserActivity
{
    public static void Add(
        SloncordDbContext db,
        Guid userId,
        string action,
        string details = "",
        string? ip = null)
    {
        db.UserActivityLogs.Add(new UserActivityLogEntity
        {
            Id = Guid.NewGuid(),
            UserId = userId,
            Action = action.Trim(),
            Details = details ?? "",
            IpAddress = string.IsNullOrWhiteSpace(ip) ? null : SloncordClientIp.Normalize(ip),
            CreatedAtUtc = DateTime.UtcNow
        });
    }

    public static async Task<string> FormatServerNameAsync(SloncordDbContext db, Guid serverId) =>
        await db.Servers.AsNoTracking()
            .Where(s => s.Id == serverId)
            .Select(s => s.Name)
            .FirstOrDefaultAsync() ?? serverId.ToString("D");

    public static async Task<string> FormatUserNicknameAsync(SloncordDbContext db, Guid userId) =>
        await db.Users.AsNoTracking()
            .Where(u => u.Id == userId)
            .Select(u => u.Nickname)
            .FirstOrDefaultAsync() ?? userId.ToString("D");

    public static async Task<string> FormatChannelLocationAsync(SloncordDbContext db, Guid channelId)
    {
        var ch = await db.Channels.AsNoTracking()
            .Where(c => c.Id == channelId)
            .Select(c => new { c.Name, c.Kind, c.ServerId })
            .FirstOrDefaultAsync();
        if (ch is null) return channelId.ToString("D");
        if (ch.Kind == ChannelKindEntity.Direct) return "Личные сообщения";
        if (ch.ServerId is null) return $"#{ch.Name}";
        var serverName = await db.Servers.AsNoTracking()
            .Where(s => s.Id == ch.ServerId)
            .Select(s => s.Name)
            .FirstOrDefaultAsync();
        return serverName is not null ? $"{serverName} / #{ch.Name}" : $"#{ch.Name}";
    }

    public static async Task LogMessageSendAsync(
        SloncordDbContext db, Guid userId, Guid channelId, string? text, bool hasFile, string? ip)
    {
        var ch = await db.Channels.AsNoTracking()
            .Where(c => c.Id == channelId)
            .Select(c => c.Kind)
            .FirstOrDefaultAsync();
        var action = ch == ChannelKindEntity.Direct ? "dm.message.send" : "message.send";
        var location = await FormatChannelLocationAsync(db, channelId);
        var preview = string.IsNullOrWhiteSpace(text)
            ? (hasFile ? "📎 Вложение" : "—")
            : Truncate(text);
        Add(db, userId, action, $"channel={location};preview={preview}", ip);
    }

    public static string Truncate(string? text, int max = 80)
    {
        var t = (text ?? "").Replace('\n', ' ').Trim();
        if (t.Length <= max) return t;
        return t[..max].TrimEnd() + "…";
    }

    public static string FormatActionLabel(string action) => action switch
    {
        "user.register" => "Регистрация",
        "user.login" => "Вход",
        "user.profile.update" => "Изменение профиля",
        "user.avatar.update" => "Смена аватара",
        "user.password.change" => "Смена пароля",
        "server.create" => "Создание сервера",
        "server.join" => "Вступление на сервер",
        "server.leave" => "Выход с сервера",
        "server.update" => "Изменение сервера",
        "server.delete" => "Удаление сервера",
        "server.member.kick" => "Исключение участника",
        "server.member.ban" => "Бан на сервере",
        "server.member.admin" => "Изменение прав администратора",
        "channel.create" => "Создание канала",
        "channel.delete" => "Удаление канала",
        "message.send" => "Отправка сообщения",
        "message.edit" => "Редактирование сообщения",
        "message.delete" => "Удаление сообщения",
        "dm.start" => "Начало личной переписки",
        "dm.message.send" => "Сообщение в личку",
        "dm.message.edit" => "Редактирование в личке",
        "dm.message.delete" => "Удаление в личке",
        "dm.delete" => "Удаление личной переписки",
        "report.submit" => "Жалоба на сообщение",
        _ => action
    };

    public static string FormatDetailsLabel(string action, string details)
    {
        if (string.IsNullOrWhiteSpace(details)) return "—";

        var parts = new List<string>();
        foreach (var seg in details.Split(';', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries))
        {
            var eq = seg.IndexOf('=');
            if (eq < 0)
            {
                parts.Add(seg);
                continue;
            }

            var key = seg[..eq].Trim();
            var val = seg[(eq + 1)..].Trim();
            parts.Add(key switch
            {
                "login" => $"Логин: {val}",
                "nickname" => $"Ник: {val}",
                "name" => $"Название: {val}",
                "server" => $"Сервер: {val}",
                "channel" => $"Канал: {val}",
                "preview" => $"Текст: {val}",
                "target" => $"Пользователь: {val}",
                "type" => $"Тип: {val}",
                "reason" => $"Причина: {val}",
                "isAdmin" => val.Equals("true", StringComparison.OrdinalIgnoreCase) ? "Назначен администратором" : "Снят с администраторов",
                "forPeer" => val.Equals("true", StringComparison.OrdinalIgnoreCase) ? "Удалено у обоих" : "Скрыто только у себя",
                _ => $"{key}: {val}"
            });
        }

        return parts.Count > 0 ? string.Join(" · ", parts) : details;
    }
}
