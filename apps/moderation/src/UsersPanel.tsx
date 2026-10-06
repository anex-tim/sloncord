import { useCallback, useEffect, useState } from "react";
import { api, type PlatformUser } from "./api";
import { ConfirmDialog } from "./ConfirmDialog";
import { ModeratorPermissionsForm } from "./ModeratorPermissionsForm";
import { UserModerationForm } from "./UserModerationForm";
import { hasPerm, isRootUser, type PlatformMe } from "./platformPerms";

type UsersSubTab = "users" | "moderators";

type Props = {
  me: PlatformMe | null;
  fmtDate: (iso?: string | null) => string;
  onReloadAudit: () => void;
  onStatus: (msg: string) => void;
  onError: (msg: string) => void;
  clearAlerts: () => void;
};

export function UsersPanel({ me, fmtDate, onReloadAudit, onStatus, onError, clearAlerts }: Props) {
  const [subTab, setSubTab] = useState<UsersSubTab>("users");
  const [userQuery, setUserQuery] = useState("");
  const [users, setUsers] = useState<PlatformUser[]>([]);
  const [usersTotal, setUsersTotal] = useState(0);
  const [selectedUser, setSelectedUser] = useState<PlatformUser | null>(null);
  const [clearAllOpen, setClearAllOpen] = useState(false);
  const [clearingAll, setClearingAll] = useState(false);

  const canClearAllActivity = hasPerm(me, "clearUserActivity");

  const loadUsers = useCallback(async (roleOverride?: UsersSubTab) => {
    const q = userQuery.trim();
    const roleKey = roleOverride ?? subTab;
    const role = roleKey === "moderators" ? "moderators" : "users";
    const res = await api<{ items: PlatformUser[]; total: number }>(
      `/platform/users?q=${encodeURIComponent(q)}&role=${role}&take=100`
    );
    const items = res.items || [];
    setUsers(items);
    setUsersTotal(res.total || 0);
    setSelectedUser((cur) => {
      if (!cur) return cur;
      return items.find((u) => u.id === cur.id) ?? null;
    });
  }, [userQuery, subTab]);

  useEffect(() => {
    void loadUsers().catch((e) => onError(e instanceof Error ? e.message : String(e)));
  }, [loadUsers, onError]);

  const appointModerator = async (user: PlatformUser) => {
    if (!me?.isRoot) return;
    clearAlerts();
    try {
      await api(`/platform/moderators/${user.id}`, {
        method: "PUT",
        body: { permissions: [] },
      });
      onStatus(`${user.nickname} назначен модератором`);
      setSubTab("moderators");
      setSelectedUser(null);
      await loadUsers("moderators");
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e));
    }
  };

  const showModeratorsTab = me?.isRoot === true;

  return (
    <section className="panel panel--fill users-panel">
      <div className="users-subnav">
        <button
          type="button"
          className={subTab === "users" ? "users-subnav__btn active" : "users-subnav__btn"}
          onClick={() => {
            setSubTab("users");
            setSelectedUser(null);
          }}
        >
          Пользователи
        </button>
        {showModeratorsTab ? (
          <button
            type="button"
            className={subTab === "moderators" ? "users-subnav__btn active" : "users-subnav__btn"}
            onClick={() => {
              setSubTab("moderators");
              setSelectedUser(null);
            }}
          >
            Модераторы
          </button>
        ) : null}
      </div>

      <div className="row users-toolbar">
        <input
          value={userQuery}
          onChange={(e) => setUserQuery(e.target.value)}
          placeholder="Поиск по логину или нику"
          onKeyDown={(e) => e.key === "Enter" && void loadUsers()}
        />
        <button type="button" onClick={() => void loadUsers()}>Найти</button>
        <span className="muted">Всего: {usersTotal}</span>
        {canClearAllActivity ? (
          <button
            type="button"
            className="ghost danger"
            disabled={clearingAll}
            onClick={() => setClearAllOpen(true)}
          >
            Очистить все журналы
          </button>
        ) : null}
      </div>

      <div className="user-split users-panel__split">
        <div className="user-split__table">
          <table className="table">
            <thead>
              <tr>
                <th>Ник</th>
                <th>Логин</th>
                <th>Серверов</th>
                <th>Статус</th>
              </tr>
            </thead>
            <tbody>
              {users.map((u) => (
                <tr
                  key={u.id}
                  className={selectedUser?.id === u.id ? "selected" : ""}
                  onClick={() => setSelectedUser(u)}
                >
                  <td>{u.nickname}</td>
                  <td>{u.login}</td>
                  <td>{u.serverCount ?? 0}</td>
                  <td>
                    {u.isPlatformModerator ? <span className="badge ok">mod</span> : null}
                    {u.isPlatformBanned ? <span className="badge bad">ban</span> : null}
                    {u.isChatMuted ? <span className="badge warn">mute</span> : null}
                    {!u.isPlatformBanned && !u.isChatMuted && !u.isPlatformModerator ? (
                      <span className="badge ok">ok</span>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {selectedUser ? (
          <aside className="user-split__aside" aria-label="Карточка пользователя">
            {subTab === "moderators" && me ? (
              <ModeratorPermissionsForm
                key={selectedUser.id}
                user={selectedUser}
                me={me}
                fmtDate={fmtDate}
                onReload={loadUsers}
                onRevoked={() => {
                  setSelectedUser(null);
                  setSubTab("users");
                }}
                onStatus={onStatus}
                onError={onError}
              />
            ) : (
              <UserModerationForm
                key={selectedUser.id}
                user={selectedUser}
                me={me}
                fmtDate={fmtDate}
                onReloadUsers={loadUsers}
                onReloadAudit={onReloadAudit}
                onStatus={onStatus}
                onError={onError}
                clearAlerts={clearAlerts}
                onAppointModerator={
                  me?.isRoot && !selectedUser.isPlatformModerator && !isRootUser(selectedUser)
                    ? () => void appointModerator(selectedUser)
                    : undefined
                }
              />
            )}
          </aside>
        ) : null}
      </div>
      <ConfirmDialog
        open={clearAllOpen}
        message="Удалить журналы действий всех пользователей? Это действие необратимо."
        confirmLabel="Очистить все"
        onConfirm={() => {
          setClearAllOpen(false);
          setClearingAll(true);
          void (async () => {
            try {
              const res = await api<{ removed?: number }>("/platform/user-activity", { method: "DELETE" });
              onStatus(`Все журналы очищены (${res.removed ?? 0} записей)`);
              onReloadAudit();
            } catch (e) {
              onError(e instanceof Error ? e.message : String(e));
            } finally {
              setClearingAll(false);
            }
          })();
        }}
        onCancel={() => setClearAllOpen(false)}
      />
    </section>
  );
}
