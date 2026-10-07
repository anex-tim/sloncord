namespace Sloncord;

[Flags]
public enum PlatformModeratorPerm : ulong
{
    None = 0,
    ViewUsers = 1UL << 0,
    BanUsers = 1UL << 1,
    MuteChat = 1UL << 2,
    RevokeSessions = 1UL << 3,
    ViewServers = 1UL << 4,
    DeleteServers = 1UL << 5,
    ViewChats = 1UL << 6,
    ViewDms = 1UL << 7,
    SearchMessages = 1UL << 8,
    DeleteMessages = 1UL << 9,
    ViewReports = 1UL << 10,
    ViewAudit = 1UL << 11,
    PermanentBan = 1UL << 12,
    ViewServerLogs = 1UL << 13,
    ViewUserActivity = 1UL << 14,
    ViewUserIps = 1UL << 15,
    BanIps = 1UL << 16,
    ClearUserActivity = 1UL << 17,
    ApproveAccounts = 1UL << 18,
}

internal static class SloncordPlatformModeratorPerms
{
    public static bool IsRootLogin(string? login)
    {
        if (string.IsNullOrWhiteSpace(login)) return false;
        var root = Environment.GetEnvironmentVariable("SLONCORD_ROOT_LOGIN");
        if (string.IsNullOrWhiteSpace(root)) return false;
        return string.Equals(login.Trim(), root.Trim(), StringComparison.OrdinalIgnoreCase);
    }

    public static ulong Sanitize(ulong raw)
    {
        var p = raw;
        if (!Has(p, PlatformModeratorPerm.ViewUsers))
        {
            p &= ~(ulong)(PlatformModeratorPerm.BanUsers
                | PlatformModeratorPerm.MuteChat
                | PlatformModeratorPerm.RevokeSessions);
        }

        if (!Has(p, PlatformModeratorPerm.BanUsers))
            p &= ~(ulong)PlatformModeratorPerm.PermanentBan;

        if (!Has(p, PlatformModeratorPerm.PermanentBan))
            p &= ~(ulong)PlatformModeratorPerm.BanIps;

        if (!Has(p, PlatformModeratorPerm.ViewUsers))
        {
            p &= ~(ulong)(PlatformModeratorPerm.ViewUserActivity
                | PlatformModeratorPerm.ViewUserIps
                | PlatformModeratorPerm.ClearUserActivity
                | PlatformModeratorPerm.ApproveAccounts);
        }

        if (!Has(p, PlatformModeratorPerm.ViewUserActivity))
            p &= ~(ulong)PlatformModeratorPerm.ClearUserActivity;

        if (!Has(p, PlatformModeratorPerm.ViewServers))
            p &= ~(ulong)PlatformModeratorPerm.DeleteServers;

        if (!Has(p, PlatformModeratorPerm.ViewChats))
            p &= ~(ulong)PlatformModeratorPerm.ViewDms;

        return p;
    }

    public static ulong All => ulong.MaxValue;

    public static bool Has(ulong mask, PlatformModeratorPerm perm) =>
        (mask & (ulong)perm) != 0;

    public static string ToKey(PlatformModeratorPerm perm) => perm switch
    {
        PlatformModeratorPerm.ViewUsers => "viewUsers",
        PlatformModeratorPerm.BanUsers => "banUsers",
        PlatformModeratorPerm.MuteChat => "muteChat",
        PlatformModeratorPerm.RevokeSessions => "revokeSessions",
        PlatformModeratorPerm.ViewServers => "viewServers",
        PlatformModeratorPerm.DeleteServers => "deleteServers",
        PlatformModeratorPerm.ViewChats => "viewChats",
        PlatformModeratorPerm.ViewDms => "viewDms",
        PlatformModeratorPerm.SearchMessages => "searchMessages",
        PlatformModeratorPerm.DeleteMessages => "deleteMessages",
        PlatformModeratorPerm.ViewReports => "viewReports",
        PlatformModeratorPerm.ViewAudit => "viewAudit",
        PlatformModeratorPerm.PermanentBan => "permanentBan",
        PlatformModeratorPerm.ViewServerLogs => "viewServerLogs",
        PlatformModeratorPerm.ViewUserActivity => "viewUserActivity",
        PlatformModeratorPerm.ViewUserIps => "viewUserIps",
        PlatformModeratorPerm.BanIps => "banIps",
        PlatformModeratorPerm.ClearUserActivity => "clearUserActivity",
        PlatformModeratorPerm.ApproveAccounts => "approveAccounts",
        _ => perm.ToString()
    };

    public static PlatformModeratorPerm? FromKey(string key)
    {
        var k = (key ?? "").Trim();
        if (k.Length == 0) return null;
        foreach (PlatformModeratorPerm p in Enum.GetValues<PlatformModeratorPerm>())
        {
            if (p == PlatformModeratorPerm.None) continue;
            if (string.Equals(ToKey(p), k, StringComparison.OrdinalIgnoreCase))
                return p;
        }
        return null;
    }

    public static ulong FromKeys(IEnumerable<string>? keys)
    {
        ulong mask = 0;
        if (keys is null) return 0;
        foreach (var key in keys)
        {
            var p = FromKey(key);
            if (p is not null) mask |= (ulong)p;
        }
        return Sanitize(mask);
    }

    public static List<string> ToKeys(ulong mask)
    {
        var list = new List<string>();
        foreach (PlatformModeratorPerm p in Enum.GetValues<PlatformModeratorPerm>())
        {
            if (p == PlatformModeratorPerm.None) continue;
            if (Has(mask, p)) list.Add(ToKey(p));
        }
        return list;
    }

    public static List<object> DescribeAll()
    {
        var rows = new (PlatformModeratorPerm Perm, string Label, PlatformModeratorPerm? Requires)[]
        {
            (PlatformModeratorPerm.ViewUsers, "Просмотр списка пользователей", null),
            (PlatformModeratorPerm.ApproveAccounts, "Одобрять аккаунты", PlatformModeratorPerm.ViewUsers),
            (PlatformModeratorPerm.BanUsers, "Заблокировать аккаунт", PlatformModeratorPerm.ViewUsers),
            (PlatformModeratorPerm.MuteChat, "Заблокировать чат", PlatformModeratorPerm.ViewUsers),
            (PlatformModeratorPerm.RevokeSessions, "Завершать сессии пользователей", PlatformModeratorPerm.ViewUsers),
            (PlatformModeratorPerm.PermanentBan, "Возможность вечной блокировки", PlatformModeratorPerm.BanUsers),
            (PlatformModeratorPerm.ViewServers, "Просмотр списка серверов", null),
            (PlatformModeratorPerm.DeleteServers, "Удаление серверов", PlatformModeratorPerm.ViewServers),
            (PlatformModeratorPerm.ViewChats, "Просмотр чатов", null),
            (PlatformModeratorPerm.ViewDms, "Просмотр личных сообщений", PlatformModeratorPerm.ViewChats),
            (PlatformModeratorPerm.SearchMessages, "Поиск сообщений", null),
            (PlatformModeratorPerm.DeleteMessages, "Удаление сообщений", null),
            (PlatformModeratorPerm.ViewReports, "Просмотр жалоб", null),
            (PlatformModeratorPerm.ViewAudit, "Просмотр журнала действий", null),
            (PlatformModeratorPerm.ViewServerLogs, "Просмотр логов сервера", null),
            (PlatformModeratorPerm.ViewUserActivity, "Журнал действий пользователя", PlatformModeratorPerm.ViewUsers),
            (PlatformModeratorPerm.ViewUserIps, "Просмотр IP пользователей", PlatformModeratorPerm.ViewUsers),
            (PlatformModeratorPerm.BanIps, "Блокировка по IP", PlatformModeratorPerm.PermanentBan),
            (PlatformModeratorPerm.ClearUserActivity, "Очистка журнала действий пользователей", PlatformModeratorPerm.ViewUserActivity),
        };

        return rows.Select(x => (object)new
        {
            key = ToKey(x.Perm),
            label = x.Label,
            requires = x.Requires is null ? null : ToKey(x.Requires.Value)
        }).ToList();
    }
}
