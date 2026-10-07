import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  api,
  getApiBase,
  getToken,
  setToken,
  formatChannelLabel,
  type PlatformMessageHit,
  type PlatformServer,
} from "./api";
import { AuditPanel } from "./AuditPanel";
import { ChatsPanel } from "./ChatsPanel";
import { ReportsPanel } from "./ReportsPanel";
import { ServerLogsPanel } from "./ServerLogsPanel";
import { UsersPanel } from "./UsersPanel";
import { AppShell } from "./AppShell";
import { connectModerationHub } from "./moderationRealtime";
import { canModerateMessage, hasPerm, type PlatformMe } from "./platformPerms";

type Tab = "users" | "servers" | "chats" | "reports" | "messages" | "audit" | "serverLogs";

function normalizeApiUrl(raw: string): string | null {
  const t = raw.trim();
  if (!t) return null;
  try {
    const u = new URL(t.includes("://") ? t : `https://${t}`);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    return u.origin;
  } catch {
    return null;
  }
}

function fmtDate(iso?: string | null): string {
  if (!iso) return "—";
  try {
    return new Intl.DateTimeFormat("ru-RU", {
      dateStyle: "short",
      timeStyle: "short",
    }).format(new Date(iso));
  } catch {
    return iso;
  }
}

export function App() {
  const [apiBaseInput, setApiBaseInput] = useState(() => getApiBase());
  const [needsApiSetup, setNeedsApiSetup] = useState(() => !getApiBase());
  const [token, setTokenState] = useState(getToken);
  const [loginForm, setLoginForm] = useState({ login: "", password: "" });
  const [tab, setTab] = useState<Tab>("users");
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");
  const [loading, setLoading] = useState(false);

  const [platformMe, setPlatformMe] = useState<PlatformMe | null>(null);

  const [servers, setServers] = useState<PlatformServer[]>([]);
  const [serversTotal, setServersTotal] = useState(0);
  const [serverQuery, setServerQuery] = useState("");
  const [selectedServerId, setSelectedServerId] = useState<string | null>(null);
  const [serverDetail, setServerDetail] = useState<{
    server: PlatformServer & { ownerLogin?: string };
    channels: { id: string; name: string; kind: string }[];
    members: { userId: string; nickname: string; login: string; isAdmin: boolean; isOwner: boolean; isPlatformBanned: boolean }[];
  } | null>(null);
  const [channelMessages, setChannelMessages] = useState<PlatformMessageHit[]>([]);

  const [msgQuery, setMsgQuery] = useState("");
  const [msgHits, setMsgHits] = useState<PlatformMessageHit[]>([]);

  const [pendingReportsCount, setPendingReportsCount] = useState(0);
  const [reportsVersion, setReportsVersion] = useState(0);
  const [auditRefreshVersion, setAuditRefreshVersion] = useState(0);
  const pendingCountRef = useRef(0);
  const pendingCountInitializedRef = useRef(false);

  const clearAlerts = () => {
    setError("");
    setStatus("");
  };

  const logout = () => {
    setToken("");
    setTokenState("");
    setPlatformMe(null);
    setServerDetail(null);
  };

  const loadPlatformMe = useCallback(async () => {
    const me = await api<PlatformMe>("/platform/me");
    setPlatformMe(me);
    return me;
  }, []);

  const saveApiBase = () => {
    const n = normalizeApiUrl(apiBaseInput);
    if (!n) {
      setError("Укажите корректный URL сервера, например https://136.234.12.106");
      return;
    }
    window.slonmod?.setApiBase?.(n);
    setNeedsApiSetup(false);
    clearAlerts();
  };

  const doLogin = async () => {
    clearAlerts();
    setLoading(true);
    try {
      const res = await api<{ token: string }>("/auth/login", {
        method: "POST",
        body: loginForm,
      });
      setToken(res.token);
      setTokenState(res.token);
      await api("/platform/access");
      await loadPlatformMe();
      setStatus("Вход выполнен");
    } catch (e) {
      logout();
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  };

  const loadServers = useCallback(async () => {
    const q = serverQuery.trim();
    const res = await api<{ items: PlatformServer[]; total: number }>(
      `/platform/servers?q=${encodeURIComponent(q)}&take=100`
    );
    setServers(res.items || []);
    setServersTotal(res.total || 0);
  }, [serverQuery]);

  const loadServerDetail = async (serverId: string) => {
    clearAlerts();
    setSelectedServerId(serverId);
    setChannelMessages([]);
    const res = await api<typeof serverDetail>(`/platform/servers/${serverId}`);
    setServerDetail(res);
  };

  const loadChannelMessages = async (channelId: string) => {
    const list = await api<PlatformMessageHit[]>(`/platform/channels/${channelId}/messages?limit=80`);
    setChannelMessages(Array.isArray(list) ? list : []);
  };

  const searchMessages = async () => {
    clearAlerts();
    setLoading(true);
    try {
      const q = msgQuery.trim();
      const list = await api<PlatformMessageHit[]>(
        `/platform/messages/search?q=${encodeURIComponent(q)}&limit=80`
      );
      setMsgHits(Array.isArray(list) ? list : []);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  };

  const bumpAuditRefresh = useCallback(() => {
    setAuditRefreshVersion((v) => v + 1);
  }, []);

  const bumpReportsList = useCallback(() => {
    setReportsVersion((v) => v + 1);
  }, []);

  const applyPendingReportsCount = useCallback(
    (next: number, forceListReload = false) => {
      setPendingReportsCount(next);
      const changed = pendingCountInitializedRef.current && next !== pendingCountRef.current;
      pendingCountRef.current = next;
      pendingCountInitializedRef.current = true;
      if (forceListReload || changed) bumpReportsList();
    },
    [bumpReportsList]
  );

  const loadPendingReportsCount = useCallback(async () => {
    if (!token || !hasPerm(platformMe, "viewReports")) {
      pendingCountRef.current = 0;
      pendingCountInitializedRef.current = false;
      setPendingReportsCount(0);
      return;
    }
    try {
      const res = await api<{ total: number }>("/platform/reports?status=pending&take=1");
      applyPendingReportsCount(res.total || 0);
    } catch {
      /* ignore */
    }
  }, [token, platformMe, applyPendingReportsCount]);

  const refreshTab = useCallback(async () => {
    if (!token) return;
    clearAlerts();
    setLoading(true);
    try {
      if (tab === "servers") await loadServers();
      if (tab === "audit") bumpAuditRefresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [token, tab, loadServers, bumpAuditRefresh]);

  useEffect(() => {
    if (!token) return;
    void loadPlatformMe().catch(() => {
      /* ignore */
    });
  }, [token, loadPlatformMe]);

  useEffect(() => {
    if (!token) return;
    void refreshTab();
  }, [token, tab, refreshTab]);

  useEffect(() => {
    if (!token) {
      pendingCountRef.current = 0;
      pendingCountInitializedRef.current = false;
      setPendingReportsCount(0);
      return;
    }

    void loadPendingReportsCount();

    const apiBase = getApiBase();
    const disconnect = connectModerationHub(
      {
        onReportsChanged: (pendingCount) => {
          applyPendingReportsCount(pendingCount, true);
        },
        onReconnect: () => {
          void loadPendingReportsCount();
        },
      },
      { apiBase, token }
    );

    const pollId = window.setInterval(() => {
      void loadPendingReportsCount();
    }, 15000);

    return () => {
      window.clearInterval(pollId);
      disconnect();
    };
  }, [token, platformMe, loadPendingReportsCount, applyPendingReportsCount]);

  const deleteServer = async (serverId: string, name: string) => {
    if (!confirm(`Удалить сервер «${name}» без возможности восстановления?`)) return;
    clearAlerts();
    try {
      await api(`/platform/servers/${serverId}`, { method: "DELETE" });
      setStatus("Сервер удалён");
      setServerDetail(null);
      setSelectedServerId(null);
      await loadServers();
      bumpAuditRefresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const deleteMessage = async (messageId: string) => {
    if (!confirm("Удалить сообщение?")) return;
    clearAlerts();
    try {
      await api(`/platform/messages/${messageId}`, { method: "DELETE" });
      setStatus("Сообщение удалено");
      setMsgHits((prev) => prev.filter((m) => m.id !== messageId));
      setChannelMessages((prev) => prev.filter((m) => m.id !== messageId));
      bumpAuditRefresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const tabTitle: Record<Tab, string> = {
    users: "Пользователи",
    servers: "Серверы",
    chats: "Чаты",
    reports: "Жалобы",
    messages: "Поиск сообщений",
    audit: "Журнал действий",
    serverLogs: "Логи сервера",
  };

  const tabPerm: Record<Tab, PlatformMe["permissions"][number] | null> = {
    users: "viewUsers",
    servers: "viewServers",
    chats: "viewChats",
    reports: "viewReports",
    messages: "searchMessages",
    audit: "viewAudit",
    serverLogs: "viewServerLogs",
  };

  const visibleTabs = useMemo(() => {
    const all: Tab[] = ["users", "servers", "chats", "reports", "messages", "audit", "serverLogs"];
    if (!platformMe) return all;
    return all.filter((t) => {
      const p = tabPerm[t];
      return !p || hasPerm(platformMe, p);
    });
  }, [platformMe]);

  useEffect(() => {
    if (!platformMe || visibleTabs.includes(tab)) return;
    setTab(visibleTabs[0] ?? "users");
  }, [platformMe, visibleTabs, tab]);

  const showRefresh = tab === "servers" || tab === "messages" || tab === "audit";

  const headerSubtitle = useMemo(() => {
    const base = getApiBase();
    return base || "API не задан";
  }, [needsApiSetup, token]);

  const pushError = (msg: string) => setError(msg);
  const pushStatus = (msg: string) => setStatus(msg);

  if (needsApiSetup) {
    return (
      <AppShell>
      <div className="auth">
        <div className="card">
          <img className="auth-icon" src="./app-icon.png" alt="" width={72} height={72} draggable={false} />
          <h1>Sloncord Moderation</h1>
          <p className="muted">Укажите адрес сервера Sloncord</p>
          <input
            value={apiBaseInput}
            onChange={(e) => setApiBaseInput(e.target.value)}
            placeholder="https://136.234.12.106"
            onKeyDown={(e) => e.key === "Enter" && saveApiBase()}
          />
          {error ? <p className="err">{error}</p> : null}
          <button type="button" onClick={saveApiBase}>Продолжить</button>
        </div>
      </div>
      </AppShell>
    );
  }

  if (!token) {
    return (
      <AppShell>
      <div className="auth">
        <div className="card">
          <img className="auth-icon" src="./app-icon.png" alt="" width={72} height={72} draggable={false} />
          <h1>Sloncord Moderation</h1>
          <p className="muted">{headerSubtitle}</p>
          <input
            placeholder="Логин модератора"
            value={loginForm.login}
            onChange={(e) => setLoginForm({ ...loginForm, login: e.target.value })}
          />
          <input
            type="password"
            placeholder="Пароль"
            value={loginForm.password}
            onChange={(e) => setLoginForm({ ...loginForm, password: e.target.value })}
            onKeyDown={(e) => e.key === "Enter" && void doLogin()}
          />
          <button type="button" disabled={loading} onClick={() => void doLogin()}>
            {loading ? "Вход…" : "Войти"}
          </button>
          <button type="button" className="ghost" onClick={() => setNeedsApiSetup(true)}>
            Сменить сервер
          </button>
          {error ? <p className="err">{error}</p> : null}
          <p className="hint">
            Доступ только для аккаунтов из списка модераторов на сервере
            (<code>Sloncord:Moderation:ModeratorLogins</code> или <code>SLONCORD_MODERATOR_LOGINS</code>).
          </p>
        </div>
      </div>
      </AppShell>
    );
  }

  return (
    <AppShell>
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">
          <img className="brand-icon" src="./app-icon.png" alt="" width={36} height={36} draggable={false} />
          <div className="brand-text">
            <strong>Sloncord</strong>
            <span>Moderation</span>
          </div>
        </div>
        <nav>
          {visibleTabs.map((t) => (
            <button
              key={t}
              type="button"
              className={tab === t ? "nav-btn active" : "nav-btn"}
              onClick={() => setTab(t)}
            >
              <span className="nav-btn__label">{tabTitle[t]}</span>
              {t === "reports" && pendingReportsCount > 0 ? (
                <span className="nav-badge" aria-label={`Ожидают: ${pendingReportsCount}`}>
                  {pendingReportsCount > 99 ? "99+" : pendingReportsCount}
                </span>
              ) : null}
            </button>
          ))}
        </nav>
        <div className="sidebar-foot">
          <button type="button" className="ghost" onClick={logout}>Выйти</button>
        </div>
      </aside>

      <main className="main">
        <header className="toolbar">
          <h2>{tabTitle[tab]}</h2>
          <div className="toolbar-actions">
            {showRefresh ? (
              <button type="button" disabled={loading} onClick={() => void refreshTab()}>Обновить</button>
            ) : null}
          </div>
        </header>

        {status ? <div className="banner ok">{status}</div> : null}
        {error ? <div className="banner err">{error}</div> : null}

        {tab === "users" && (
          <UsersPanel
            me={platformMe}
            fmtDate={fmtDate}
            onReloadAudit={bumpAuditRefresh}
            onStatus={pushStatus}
            onError={pushError}
            clearAlerts={clearAlerts}
          />
        )}

        {tab === "servers" && (
          <section className="panel">
            <div className="row">
              <input
                value={serverQuery}
                onChange={(e) => setServerQuery(e.target.value)}
                placeholder="Поиск по названию или invite-коду"
                onKeyDown={(e) => e.key === "Enter" && void loadServers()}
              />
              <button type="button" onClick={() => void loadServers()}>Найти</button>
              <span className="muted">Всего: {serversTotal}</span>
            </div>
            <div className="split">
              <table className="table">
                <thead>
                  <tr>
                    <th>Название</th>
                    <th>Владелец</th>
                    <th>Участники</th>
                    <th>Каналы</th>
                  </tr>
                </thead>
                <tbody>
                  {servers.map((s) => (
                    <tr
                      key={s.id}
                      className={selectedServerId === s.id ? "selected" : ""}
                      onClick={() => void loadServerDetail(s.id)}
                    >
                      <td>{s.name}</td>
                      <td>{s.ownerNickname}</td>
                      <td>{s.memberCount}</td>
                      <td>{s.channelCount}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {serverDetail ? (
                <div className="detail">
                  <h3>{serverDetail.server.name}</h3>
                  <div className="muted">invite: {serverDetail.server.inviteCode}</div>
                  <p>{serverDetail.server.description || "—"}</p>
                  {hasPerm(platformMe, "deleteServers") ? (
                    <button
                      type="button"
                      className="danger"
                      onClick={() => void deleteServer(serverDetail.server.id, serverDetail.server.name)}
                    >
                      Удалить сервер
                    </button>
                  ) : null}
                  <h4>Каналы</h4>
                  <ul className="list">
                    {serverDetail.channels.map((ch) => (
                      <li key={ch.id}>
                        <button type="button" className="linkish" onClick={() => void loadChannelMessages(ch.id)}>
                          #{ch.name} <span className="muted">({ch.kind})</span>
                        </button>
                      </li>
                    ))}
                  </ul>
                  <h4>Участники ({serverDetail.members.length})</h4>
                  <ul className="list compact">
                    {serverDetail.members.map((m) => (
                      <li key={m.userId}>
                        {m.nickname} <span className="muted">@{m.login}</span>
                        {m.isOwner ? " · owner" : m.isAdmin ? " · admin" : ""}
                        {m.isPlatformBanned ? " · ban" : ""}
                      </li>
                    ))}
                  </ul>
                  {channelMessages.length > 0 ? (
                    <>
                      <h4>Сообщения канала</h4>
                      <div className="messages">
                        {channelMessages.map((m) => (
                          <div key={m.id} className={`msg${m.isDeleted ? " deleted" : ""}`}>
                            <div className="msg-meta">
                              <strong>{m.senderNickname}</strong>
                              <span className="muted">{fmtDate(m.createdAtUtc)}</span>
                              {!m.isDeleted && hasPerm(platformMe, "deleteMessages") && canModerateMessage(platformMe, m) ? (
                                <button type="button" className="ghost tiny" onClick={() => void deleteMessage(m.id)}>
                                  удалить
                                </button>
                              ) : null}
                            </div>
                            <div>{m.text || "—"}</div>
                          </div>
                        ))}
                      </div>
                    </>
                  ) : null}
                </div>
              ) : null}
            </div>
          </section>
        )}

        {tab === "chats" && <ChatsPanel me={platformMe} onError={pushError} onStatus={pushStatus} />}

        {tab === "reports" && (
          <ReportsPanel
            me={platformMe}
            active={tab === "reports"}
            reportsVersion={reportsVersion}
            onError={pushError}
            onStatus={pushStatus}
          />
        )}

        {tab === "messages" && (
          <section className="panel">
            <div className="row">
              <input
                value={msgQuery}
                onChange={(e) => setMsgQuery(e.target.value)}
                placeholder="Текст сообщения (мин. 2 символа)"
                onKeyDown={(e) => e.key === "Enter" && void searchMessages()}
              />
              <button type="button" disabled={loading} onClick={() => void searchMessages()}>Искать</button>
            </div>
            <div className="messages">
              {msgHits.map((m) => (
                <div key={m.id} className={`msg${m.isDeleted ? " deleted" : ""}`}>
                  <div className="msg-meta">
                    <strong>{m.senderNickname}</strong>
                    <span className="muted">
                      {formatChannelLabel({
                        name: m.channelName,
                        kind: m.channelKind,
                        serverName: m.serverName,
                      })} · {fmtDate(m.createdAtUtc)}
                    </span>
                    {!m.isDeleted && hasPerm(platformMe, "deleteMessages") && canModerateMessage(platformMe, m) ? (
                      <button type="button" className="ghost tiny" onClick={() => void deleteMessage(m.id)}>
                        удалить
                      </button>
                    ) : null}
                  </div>
                  <div>{m.text}</div>
                </div>
              ))}
            </div>
          </section>
        )}

        {tab === "audit" && (
          <AuditPanel
            active={tab === "audit"}
            refreshVersion={auditRefreshVersion}
            onError={pushError}
          />
        )}

        {tab === "serverLogs" && (
          <ServerLogsPanel active={tab === "serverLogs"} onError={pushError} />
        )}
      </main>
    </div>
    </AppShell>
  );
}
