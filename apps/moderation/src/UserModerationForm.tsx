import { useCallback, useEffect, useRef, useState } from "react";
import {
  api,
  CHAT_MUTE_DURATIONS,
  PLATFORM_BAN_DURATIONS,
  type PlatformUser,
  type PlatformUserIpInfo,
} from "./api";
import { ConfirmDialog } from "./ConfirmDialog";
import { UserActivityPanel } from "./UserActivityPanel";
import { canModerateUser, hasPerm, isRootUser, type PlatformMe } from "./platformPerms";

type Props = {
  user: PlatformUser;
  me: PlatformMe | null;
  fmtDate: (iso?: string | null) => string;
  onReloadUsers: () => Promise<void>;
  onReloadAudit: () => void;
  onStatus: (msg: string) => void;
  onError: (msg: string) => void;
  clearAlerts: () => void;
  onAppointModerator?: () => void;
};

type PendingConfirm = {
  message: string;
  confirmLabel?: string;
  action: () => Promise<void>;
  focus?: "ban" | "chat";
};

function isBanned(user: PlatformUser): boolean {
  return user.isPlatformBanned === true;
}

function isChatMuted(user: PlatformUser): boolean {
  return user.isChatMuted === true;
}

export function UserModerationForm({
  user,
  me,
  fmtDate,
  onReloadUsers,
  onReloadAudit,
  onStatus,
  onError,
  clearAlerts,
  onAppointModerator,
}: Props) {
  const banReasonRef = useRef<HTMLInputElement>(null);
  const chatMuteReasonRef = useRef<HTMLInputElement>(null);
  const ipBanReasonRef = useRef<HTMLInputElement>(null);
  const [banReason, setBanReason] = useState("");
  const [banMinutes, setBanMinutes] = useState(0);
  const [chatMuteReason, setChatMuteReason] = useState("");
  const [chatMuteMinutes, setChatMuteMinutes] = useState(1440);
  const [ipBanReason, setIpBanReason] = useState("");
  const [ipBanMinutes, setIpBanMinutes] = useState(0);
  const [ipInfo, setIpInfo] = useState<PlatformUserIpInfo | null>(null);
  const [pendingConfirm, setPendingConfirm] = useState<PendingConfirm | null>(null);
  const [focusTarget, setFocusTarget] = useState<"ban" | "chat" | null>(null);

  const banned = isBanned(user);
  const chatMuted = isChatMuted(user);
  const rootProtected = isRootUser(user) && !me?.isRoot;
  const canActOnUser = canModerateUser(me, user);
  const canApprove = canActOnUser && hasPerm(me, "approveAccounts") && !isRootUser(user);
  const canBan = canActOnUser && hasPerm(me, "banUsers");
  const canMute = canActOnUser && hasPerm(me, "muteChat");
  const canRevoke = canActOnUser && hasPerm(me, "revokeSessions");
  const canPermanentBan = hasPerm(me, "permanentBan");
  const canViewIps = hasPerm(me, "viewUserIps");
  const canViewActivity = hasPerm(me, "viewUserActivity");
  const canClearActivity = hasPerm(me, "clearUserActivity");
  const canBanIp = canActOnUser && hasPerm(me, "banIps");
  const banDurations = canPermanentBan
    ? PLATFORM_BAN_DURATIONS
    : PLATFORM_BAN_DURATIONS.filter((d) => d.minutes > 0);
  const ipBanDurations = banDurations;

  const loadUserDetail = useCallback(async () => {
    if (!canViewIps) {
      setIpInfo(null);
      return;
    }
    try {
      const res = await api<{ ip?: PlatformUserIpInfo | null }>(`/platform/users/${user.id}`);
      setIpInfo(res.ip ?? null);
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e));
    }
  }, [user.id, canViewIps, onError]);

  useEffect(() => {
    void loadUserDetail();
  }, [loadUserDetail]);

  useEffect(() => {
    if (!banned) setBanReason("");
  }, [banned, user.id]);

  useEffect(() => {
    if (!chatMuted) setChatMuteReason("");
  }, [chatMuted, user.id]);

  useEffect(() => {
    if (!focusTarget) return;
    const el = focusTarget === "ban" ? banReasonRef.current : chatMuteReasonRef.current;
    if (!el) return;
    const t = window.setTimeout(() => {
      try {
        el.focus();
        el.select();
      } catch {
        /* ignore */
      }
      setFocusTarget(null);
    }, 0);
    return () => clearTimeout(t);
  }, [focusTarget, banned, chatMuted]);

  const askConfirm = (next: PendingConfirm) => {
    setPendingConfirm(next);
  };

  const runConfirmed = () => {
    if (!pendingConfirm) return;
    const { action, focus } = pendingConfirm;
    setPendingConfirm(null);
    void (async () => {
      try {
        await action();
        if (focus) setFocusTarget(focus);
      } catch {
        /* onError внутри action */
      }
    })();
  };

  const setApproval = async (approved: boolean) => {
    clearAlerts();
    try {
      await api(`/platform/users/${user.id}/approval`, {
        method: "POST",
        body: { approved },
      });
      onStatus(approved ? "Аккаунт одобрен" : "Одобрение аккаунта отозвано. Сессия пользователя завершена.");
      onReloadAudit();
      await onReloadUsers();
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e));
    }
  };

  const banUser = async () => {
    clearAlerts();
    const reason = banReason.trim();
    const durationMinutes = banMinutes > 0 ? banMinutes : null;
    await api(`/platform/users/${user.id}/ban`, {
      method: "POST",
      body: { reason, durationMinutes },
    });
    onStatus("Пользователь заблокирован");
    await onReloadUsers();
    await onReloadAudit();
  };

  const unbanUser = async () => {
    clearAlerts();
    await api(`/platform/users/${user.id}/ban`, { method: "DELETE" });
    onStatus("Блокировка снята");
    await onReloadUsers();
    await onReloadAudit();
  };

  const muteUserChat = async () => {
    const reason = chatMuteReason.trim();
    if (!reason) {
      onError("Укажите причину блокировки чата");
      setFocusTarget("chat");
      return;
    }
    clearAlerts();
    await api(`/platform/users/${user.id}/chat-mute`, {
      method: "POST",
      body: { reason, durationMinutes: chatMuteMinutes },
    });
    onStatus("Чат пользователя временно заблокирован");
    await onReloadUsers();
    await onReloadAudit();
  };

  const unmuteUserChat = async () => {
    clearAlerts();
    await api(`/platform/users/${user.id}/chat-mute`, { method: "DELETE" });
    onStatus("Блокировка чата снята");
    await onReloadUsers();
    await onReloadAudit();
  };

  const revokeSessions = async () => {
    clearAlerts();
    await api(`/platform/users/${user.id}/sessions`, { method: "DELETE" });
    onStatus("Сессии завершены");
    await onReloadAudit();
    await loadUserDetail();
  };

  const banUserIp = async () => {
    clearAlerts();
    const reason = ipBanReason.trim();
    const durationMinutes = ipBanMinutes > 0 ? ipBanMinutes : null;
    await api(`/platform/users/${user.id}/ban-ip`, {
      method: "POST",
      body: { reason, durationMinutes },
    });
    onStatus("IP-адрес заблокирован");
    await onReloadAudit();
    await loadUserDetail();
  };

  const wrapAction = (fn: () => Promise<void>) => async () => {
    try {
      await fn();
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e));
    }
  };

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
          <dt>Последний визит</dt>
          <dd>{fmtDate(user.lastSeenAtUtc)}</dd>
          {banned ? (
            <>
              <dt>Блокировка аккаунта</dt>
              <dd>
                {user.platformBanReason || "без причины"}
                <div className="muted small">
                  {user.platformBanPermanent ? "бессрочно" : `до ${fmtDate(user.platformBannedUntilUtc)}`}
                </div>
              </dd>
            </>
          ) : null}
          {chatMuted ? (
            <>
              <dt>Блокировка чата</dt>
              <dd>
                {user.chatMuteReason || "без причины"}
                <div className="muted small">до {fmtDate(user.chatMutedUntilUtc)}</div>
              </dd>
            </>
          ) : null}
        </dl>
        {rootProtected ? (
          <p className="mod-perms-hint muted">Пользователь root защищён от действий модераторов платформы.</p>
        ) : null}
        {onAppointModerator ? (
          <button type="button" className="mod-appoint-btn" onClick={onAppointModerator}>
            Назначить модератором
          </button>
        ) : null}
        {canApprove ? (
          <button
            type="button"
            className={user.accountApproved === false ? undefined : "danger"}
            onClick={() =>
              askConfirm({
                message: user.accountApproved === false
                  ? "Одобрить аккаунт? Пользователь сможет войти в Sloncord."
                  : "Отозвать одобрение аккаунта? Текущая сессия будет завершена, и пользователь не сможет пользоваться Sloncord, пока аккаунт снова не одобрят.",
                confirmLabel: user.accountApproved === false ? "Одобрить" : "Отозвать",
                action: () => setApproval(user.accountApproved === false),
              })
            }
          >
            {user.accountApproved === false ? "Одобрить аккаунт" : "Отозвать одобрение аккаунта"}
          </button>
        ) : null}
        {!banned && canBan ? (
          <>
            <input
              ref={banReasonRef}
              type="text"
              className="mod-reason-input"
              autoComplete="off"
              spellCheck
              placeholder="Причина блокировки аккаунта (необязательно)"
              value={banReason}
              onChange={(e) => setBanReason(e.target.value)}
            />
            <label className="pager-size">
              <span className="muted small">Срок блокировки</span>
              <select value={banMinutes} onChange={(e) => setBanMinutes(Number(e.target.value))}>
                {banDurations.map((d) => (
                  <option key={d.minutes} value={d.minutes}>
                    {d.label}
                  </option>
                ))}
              </select>
            </label>
            <button
              type="button"
              className="danger"
              onClick={() =>
                askConfirm({
                  message: "Заблокировать пользователя на всей платформе?",
                  confirmLabel: "Заблокировать",
                  action: wrapAction(banUser),
                })
              }
            >
              Заблокировать аккаунт
            </button>
          </>
        ) : banned && canBan ? (
          <button
            type="button"
            onClick={() =>
              askConfirm({
                message: "Снять блокировку с пользователя?",
                confirmLabel: "Снять блокировку",
                action: wrapAction(unbanUser),
                focus: "ban",
              })
            }
          >
            Снять блокировку аккаунта
          </button>
        ) : null}
        {canMute ? (
        <div className="mod-action-block">
          <h4>Блокировка чата</h4>
          {!chatMuted ? (
            <>
              <input
                ref={chatMuteReasonRef}
                type="text"
                className="mod-reason-input"
                autoComplete="off"
                spellCheck
                placeholder="Причина блокировки чата"
                value={chatMuteReason}
                onChange={(e) => setChatMuteReason(e.target.value)}
              />
              <label className="pager-size">
                <span className="muted small">Срок</span>
                <select value={chatMuteMinutes} onChange={(e) => setChatMuteMinutes(Number(e.target.value))}>
                  {CHAT_MUTE_DURATIONS.map((d) => (
                    <option key={d.minutes} value={d.minutes}>
                      {d.label}
                    </option>
                  ))}
                </select>
              </label>
              <button
                type="button"
                className="danger"
                onClick={() =>
                  askConfirm({
                    message: "Временно заблокировать чат пользователю?",
                    confirmLabel: "Заблокировать чат",
                    action: wrapAction(muteUserChat),
                  })
                }
              >
                Заблокировать чат
              </button>
            </>
          ) : (
            <button
              type="button"
              onClick={() =>
                askConfirm({
                  message: "Снять временную блокировку чата?",
                  confirmLabel: "Снять блокировку",
                  action: wrapAction(unmuteUserChat),
                  focus: "chat",
                })
              }
            >
              Снять блокировку чата
            </button>
          )}
        </div>
        ) : null}
        {canRevoke ? (
        <button
          type="button"
          className="ghost"
          onClick={() =>
            askConfirm({
              message: "Завершить все сессии пользователя?",
              confirmLabel: "Завершить",
              action: wrapAction(revokeSessions),
            })
          }
        >
          Завершить все сессии
        </button>
        ) : null}

        {canViewIps ? (
          <div className="mod-action-block user-ip-block">
            <h4>IP-адрес</h4>
            {ipInfo?.lastKnownIp ? (
              <>
                <div className="user-ip-current">
                  <code>{ipInfo.lastKnownIp}</code>
                  {ipInfo.lastKnownIpAtUtc ? (
                    <span className="muted small">последний раз {fmtDate(ipInfo.lastKnownIpAtUtc)}</span>
                  ) : null}
                </div>
                {ipInfo.sessions && ipInfo.sessions.length > 0 ? (
                  <div className="user-ip-sessions">
                    <div className="muted small">Недавние сессии</div>
                    <ul className="user-ip-session-list">
                      {ipInfo.sessions.map((s) => (
                        <li key={s.id}>
                          <span>{s.lastSeenIp || s.createdFromIp || "—"}</span>
                          <span className="muted small">{fmtDate(s.lastSeenAtUtc || s.createdAtUtc)}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : null}
              </>
            ) : (
              <p className="muted small">IP неизвестен</p>
            )}
          </div>
        ) : null}

        {canBanIp ? (
          <div className="mod-action-block">
            <h4>Блокировка по IP</h4>
            <p className="muted small">
              Блокирует последний известный IP пользователя. Доступно только с правом вечной блокировки аккаунта.
            </p>
            <input
              ref={ipBanReasonRef}
              type="text"
              className="mod-reason-input"
              autoComplete="off"
              spellCheck
              placeholder="Причина блокировки IP (необязательно)"
              value={ipBanReason}
              onChange={(e) => setIpBanReason(e.target.value)}
            />
            <label className="pager-size">
              <span className="muted small">Срок</span>
              <select value={ipBanMinutes} onChange={(e) => setIpBanMinutes(Number(e.target.value))}>
                {ipBanDurations.map((d) => (
                  <option key={d.minutes} value={d.minutes}>
                    {d.label}
                  </option>
                ))}
              </select>
            </label>
            <button
              type="button"
              className="danger"
              disabled={!ipInfo?.lastKnownIp}
              onClick={() =>
                askConfirm({
                  message: `Заблокировать IP ${ipInfo?.lastKnownIp ?? ""}?`,
                  confirmLabel: "Заблокировать IP",
                  action: wrapAction(banUserIp),
                })
              }
            >
              Заблокировать IP
            </button>
          </div>
        ) : null}

        {canViewActivity ? (
          <div className="mod-action-block user-activity-block">
            <h4>Журнал действий пользователя</h4>
            <p className="muted small">Входы, сообщения, серверы, жалобы и другие действия на платформе.</p>
            <UserActivityPanel
              key={user.id}
              userId={user.id}
              canViewIps={canViewIps}
              canClear={canClearActivity}
              fmtDate={fmtDate}
              onError={onError}
              onStatus={onStatus}
              onCleared={onReloadAudit}
            />
          </div>
        ) : null}
      </div>
      <ConfirmDialog
        open={!!pendingConfirm}
        message={pendingConfirm?.message ?? ""}
        confirmLabel={pendingConfirm?.confirmLabel}
        onConfirm={runConfirmed}
        onCancel={() => setPendingConfirm(null)}
      />
    </>
  );
}
