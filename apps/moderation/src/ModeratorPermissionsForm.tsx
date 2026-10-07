import { useEffect, useMemo, useState } from "react";
import { api, type PlatformUser } from "./api";
import {
  PLATFORM_PERM_DEFS,
  canEnablePerm,
  sanitizePerms,
  type PlatformMe,
  type PlatformPermKey,
} from "./platformPerms";
import { ConfirmDialog } from "./ConfirmDialog";

type Props = {
  user: PlatformUser;
  me: PlatformMe;
  fmtDate: (iso?: string | null) => string;
  onReload: () => Promise<void>;
  onRevoked: () => void;
  onStatus: (msg: string) => void;
  onError: (msg: string) => void;
};

export function ModeratorPermissionsForm({
  user,
  me,
  fmtDate,
  onReload,
  onRevoked,
  onStatus,
  onError,
}: Props) {
  const initial = useMemo(
    () => new Set<PlatformPermKey>((user.platformModeratorPermissions || []) as PlatformPermKey[]),
    [user.id, user.platformModeratorPermissions]
  );
  const [selected, setSelected] = useState<Set<PlatformPermKey>>(initial);
  const [saving, setSaving] = useState(false);
  const [confirmRevoke, setConfirmRevoke] = useState(false);

  useEffect(() => {
    setSelected(initial);
  }, [initial]);

  const toggle = (key: PlatformPermKey) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) {
        next.delete(key);
        for (const def of PLATFORM_PERM_DEFS) {
          if (def.requires === key) next.delete(def.key);
        }
        if (key === "banUsers") {
          next.delete("permanentBan");
          next.delete("banIps");
        }
        if (key === "permanentBan") next.delete("banIps");
        if (key === "viewServers") next.delete("deleteServers");
        if (key === "viewChats") next.delete("viewDms");
        if (key === "viewUsers") {
          next.delete("banUsers");
          next.delete("muteChat");
          next.delete("revokeSessions");
          next.delete("permanentBan");
          next.delete("approveAccounts");
        }
      } else if (canEnablePerm(next, key)) {
        next.add(key);
      }
      return next;
    });
  };

  const save = async () => {
    setSaving(true);
    try {
      const permissions = sanitizePerms([...selected]);
      await api(`/platform/moderators/${user.id}`, {
        method: "PUT",
        body: { permissions },
      });
      onStatus("Права модератора сохранены");
      await onReload();
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const revoke = async () => {
    setSaving(true);
    try {
      await api(`/platform/moderators/${user.id}`, {
        method: "PUT",
        body: { revoke: true },
      });
      onStatus("Пользователь снят с модераторов");
      setConfirmRevoke(false);
      onRevoked();
      await onReload();
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  if (!me.isRoot) {
    return (
      <div className="detail muted">
        <h3>{user.nickname}</h3>
        <p>Только root может изменять права модераторов.</p>
      </div>
    );
  }

  return (
    <>
      <div className="detail">
        <h3>{user.nickname}</h3>
        <div className="muted">@{user.login}</div>
        <dl>
          <dt>ID</dt>
          <dd>{user.id}</dd>
          <dt>Создан</dt>
          <dd>{fmtDate(user.createdAtUtc)}</dd>
        </dl>

        <h4 className="mod-section-title">Права модератора</h4>
        <div className="mod-perms">
          {PLATFORM_PERM_DEFS.map((def) => {
            const enabled = canEnablePerm(selected, def.key);
            const checked = selected.has(def.key);
            return (
              <label
                key={def.key}
                className={`mod-check${!enabled && !checked ? " mod-check--disabled" : ""}`}
                title={def.requires ? `Требуется: ${PLATFORM_PERM_DEFS.find((d) => d.key === def.requires)?.label}` : undefined}
              >
                <input
                  type="checkbox"
                  checked={checked}
                  disabled={!enabled && !checked}
                  onChange={() => toggle(def.key)}
                />
                <span>{def.label}</span>
              </label>
            );
          })}
        </div>

        <p className="muted small mod-perms-hint">
          Решение по жалобам доступно при просмотре жалоб и соответствующих правах на удаление сообщений,
          блокировку аккаунта и временную блокировку чата.
        </p>

        <div className="row">
          <button type="button" disabled={saving} onClick={() => void save()}>
            {saving ? "Сохранение…" : "Сохранить права"}
          </button>
          <button type="button" className="danger" disabled={saving} onClick={() => setConfirmRevoke(true)}>
            Снять с модераторов
          </button>
        </div>
      </div>

      <ConfirmDialog
        open={confirmRevoke}
        message={`Снять ${user.nickname} с модераторов платформы?`}
        confirmLabel="Снять"
        onConfirm={() => void revoke()}
        onCancel={() => setConfirmRevoke(false)}
      />
    </>
  );
}
