using Microsoft.EntityFrameworkCore;
using Sloncord.Data;

namespace Sloncord;

internal static class SloncordPlatformAudit
{
    public static string FormatActionLabel(string action) => action switch
    {
        "user.ban" => "Блокировка аккаунта",
        "user.unban" => "Снятие блокировки аккаунта",
        "user.chat_mute" => "Блокировка чата",
        "user.chat_unmute" => "Снятие блокировки чата",
        "user.sessions.revoke" => "Завершение всех сессий",
        "server.delete" => "Удаление сервера",
        "message.delete" => "Удаление сообщения",
        "report.resolved" => "Жалоба закрыта",
        "report.dismissed" => "Жалоба отклонена",
        "moderator.grant" => "Назначен модератором",
        "moderator.revoke" => "Снят с модераторов",
        "moderator.permissions" => "Изменены права модератора",
        "ip.ban" => "Блокировка IP",
        "ip.unban" => "Снятие блокировки IP",
        "user.activity.clear" => "Очистка журнала пользователя",
        "user.activity.clear_all" => "Очистка всех журналов пользователей",
        _ => action
    };

    public static string FormatDetailsLabel(string action, string details)
    {
        if (string.IsNullOrWhiteSpace(details)) return "—";

        if (action == "server.delete") return $"Название: {details}";

        if (action.StartsWith("report.", StringComparison.Ordinal))
            return details.Trim();

        var parts = new List<string>();
        foreach (var seg in details.Split(';', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries))
        {
            if (seg.Equals("permanent", StringComparison.OrdinalIgnoreCase))
            {
                parts.Add("Навсегда");
                continue;
            }

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
                "reason" => $"Причина: {val}",
                "until" => TryFormatRuDate(val, out var d) ? $"До: {d}" : $"До: {val}",
                "count" => $"Сессий: {val}",
                _ => $"{key}: {val}"
            });
        }

        return parts.Count > 0 ? string.Join(". ", parts) : details;
    }

    public static async Task<Dictionary<string, string>> ResolveTargetLabelsAsync(
        SloncordDbContext db,
        IReadOnlyList<PlatformModerationLogEntity> logs)
    {
        var result = new Dictionary<string, string>(StringComparer.Ordinal);

        var userIds = new HashSet<Guid>();
        var messageIds = new HashSet<Guid>();
        var serverIds = new HashSet<Guid>();
        var reportIds = new HashSet<Guid>();

        foreach (var log in logs)
        {
            if (!Guid.TryParse(log.TargetId, out var id)) continue;
            switch (log.TargetType)
            {
                case "user": userIds.Add(id); break;
                case "message": messageIds.Add(id); break;
                case "server": serverIds.Add(id); break;
                case "report": reportIds.Add(id); break;
            }
        }

        if (userIds.Count > 0)
        {
            var users = await db.Users.AsNoTracking()
                .Where(u => userIds.Contains(u.Id))
                .Select(u => new { u.Id, u.Nickname })
                .ToListAsync();
            foreach (var u in users)
                result[TargetKey("user", u.Id)] = u.Nickname;
        }

        if (messageIds.Count > 0)
        {
            var messages = await db.Messages.AsNoTracking()
                .Where(m => messageIds.Contains(m.Id))
                .Select(m => new
                {
                    m.Id,
                    m.Text,
                    SenderNickname = db.Users.Where(u => u.Id == m.SenderUserId).Select(u => u.Nickname).FirstOrDefault()
                })
                .ToListAsync();

            foreach (var m in messages)
            {
                var nick = string.IsNullOrWhiteSpace(m.SenderNickname) ? "?" : m.SenderNickname;
                var preview = Truncate(m.Text, 60);
                result[TargetKey("message", m.Id)] = string.IsNullOrWhiteSpace(preview)
                    ? $"Сообщение от {nick}"
                    : $"Сообщение от {nick}: «{preview}»";
            }
        }

        if (serverIds.Count > 0)
        {
            var servers = await db.Servers.AsNoTracking()
                .Where(s => serverIds.Contains(s.Id))
                .Select(s => new { s.Id, s.Name })
                .ToListAsync();
            foreach (var s in servers)
                result[TargetKey("server", s.Id)] = $"Сервер «{s.Name}»";
        }

        if (reportIds.Count > 0)
        {
            var reports = await db.MessageReports.AsNoTracking()
                .Where(r => reportIds.Contains(r.Id))
                .Select(r => new
                {
                    r.Id,
                    r.Reason,
                    ReporterNickname = db.Users.Where(u => u.Id == r.ReporterUserId).Select(u => u.Nickname).FirstOrDefault(),
                    SenderNickname = db.Messages
                        .Where(m => m.Id == r.MessageId)
                        .Select(m => db.Users.Where(u => u.Id == m.SenderUserId).Select(u => u.Nickname).FirstOrDefault())
                        .FirstOrDefault()
                })
                .ToListAsync();

            foreach (var r in reports)
            {
                var reporter = string.IsNullOrWhiteSpace(r.ReporterNickname) ? "?" : r.ReporterNickname;
                var sender = string.IsNullOrWhiteSpace(r.SenderNickname) ? "?" : r.SenderNickname;
                var reason = string.IsNullOrWhiteSpace(r.Reason) ? "" : $" ({Truncate(r.Reason, 40)})";
                result[TargetKey("report", r.Id)] = $"Жалоба от {reporter} на сообщение от {sender}{reason}";
            }
        }

        return result;
    }

    public static string FallbackTargetLabel(string targetType, string targetId)
    {
        var shortId = targetId.Length > 8 ? targetId[..8] + "…" : targetId;
        return targetType switch
        {
            "user" => $"Пользователь {shortId}",
            "message" => $"Сообщение {shortId}",
            "server" => $"Сервер {shortId}",
            "report" => $"Жалоба {shortId}",
            _ => $"{targetType}:{shortId}"
        };
    }

    private static string TargetKey(string targetType, Guid id) => $"{targetType}:{id:D}";

    private static string Truncate(string? text, int max)
    {
        var t = (text ?? "").Replace('\n', ' ').Trim();
        if (t.Length <= max) return t;
        return t[..max].TrimEnd() + "…";
    }

    private static bool TryFormatRuDate(string raw, out string formatted)
    {
        formatted = "";
        if (!DateTime.TryParse(raw, null, System.Globalization.DateTimeStyles.RoundtripKind, out var dt))
            return false;
        formatted = dt.ToLocalTime().ToString("dd.MM.yyyy HH:mm");
        return true;
    }
}
