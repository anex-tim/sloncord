import { useCallback, useEffect, useState } from "react";
import {
  api,
  CHAT_MUTE_DURATIONS,
  PLATFORM_BAN_DURATIONS,
  formatChannelLabel,
  type PlatformReport,
} from "./api";
import { MessageBody } from "./MessageBody";
import { canModerateMessage, canResolveReportOption, isRootMessage, type PlatformMe } from "./platformPerms";

function fmtDate(iso?: string | null): string {
  if (!iso) return "—";
  try {
    return new Intl.DateTimeFormat("ru-RU", { dateStyle: "short", timeStyle: "short" }).format(new Date(iso));
  } catch {
    return iso;
  }
}

type Props = {
  me: PlatformMe | null;
  onError: (msg: string) => void;
  onStatus: (msg: string) => void;
  active?: boolean;
  reportsVersion?: number;
};

export function ReportsPanel({ me, onError, onStatus, active = true, reportsVersion = 0 }: Props) {
  const [statusFilter, setStatusFilter] = useState("pending");
  const [reports, setReports] = useState<PlatformReport[]>([]);
  const [total, setTotal] = useState(0);
  const [selected, setSelected] = useState<PlatformReport | null>(null);
  const [note, setNote] = useState("");
  const [banReason, setBanReason] = useState("");
  const [banMinutes, setBanMinutes] = useState(0);
  const [deleteMsg, setDeleteMsg] = useState(false);
  const [banUser, setBanUser] = useState(false);
  const [muteChat, setMuteChat] = useState(false);
  const [chatMuteReason, setChatMuteReason] = useState("");
  const [chatMuteMinutes, setChatMuteMinutes] = useState(1440);

  const [loadError, setLoadError] = useState("");
  const reportRootProtected = selected?.message ? isRootMessage(selected.message) && !me?.isRoot : false;
  const canActOnReport = selected?.message ? canModerateMessage(me, selected.message) : true;
  const canDeleteMsg = canActOnReport && canResolveReportOption(me, "deleteMessage");
  const canBan = canActOnReport && canResolveReportOption(me, "banUser");
  const canMute = canActOnReport && canResolveReportOption(me, "muteChat");
  const canPermanentBan = canResolveReportOption(me, "permanentBan");
  const banDurations = canPermanentBan
    ? PLATFORM_BAN_DURATIONS
    : PLATFORM_BAN_DURATIONS.filter((d) => d.minutes > 0);
  const hasSelectedActions = deleteMsg || banUser || muteChat;

  const loadReports = useCallback(async () => {
    setLoadError("");
    const res = await api<{ items: PlatformReport[]; total: number }>(
      `/platform/reports?status=${encodeURIComponent(statusFilter)}&take=100`
    );
    setReports(res.items || []);
    setTotal(res.total || 0);
  }, [statusFilter]);

  useEffect(() => {
    if (!active) return;
    void loadReports().catch((e) => {
      const msg = e instanceof Error ? e.message : String(e);
      setLoadError(msg);
      onError(msg);
    });
  }, [loadReports, onError, active, reportsVersion]);

  const openReport = async (id: string) => {
    try {
      const r = await api<PlatformReport>(`/platform/reports/${id}`);
      setSelected(r);
      setNote("");
      setBanReason(r.reason || "");
      setBanMinutes(0);
      setDeleteMsg(false);
      setBanUser(false);
      setMuteChat(false);
      setChatMuteReason(r.reason || "");
      setChatMuteMinutes(1440);
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e));
    }
  };

  const resolve = async (nextStatus: "resolved" | "dismissed") => {
    if (!selected) return;
    try {
      await api(`/platform/reports/${selected.id}/resolve`, {
        method: "POST",
        body: {
          status: nextStatus,
          note: note.trim(),
          deleteMessage: deleteMsg,
          banUser: banUser,
          banReason: banReason.trim(),
          banDurationMinutes: banMinutes > 0 ? banMinutes : null,
          muteChat: muteChat,
          chatMuteReason: chatMuteReason.trim(),
          chatMuteDurationMinutes: chatMuteMinutes,
        },
      });
      onStatus(nextStatus === "resolved" ? "Жалоба закрыта" : "Жалоба отклонена");
      setSelected(null);
      await loadReports();
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <section className="panel panel--fill reports-panel">
      <div className="row reports-toolbar">
        <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
          <option value="pending">Ожидают</option>
          <option value="resolved">Закрыты</option>
          <option value="dismissed">Отклонены</option>
          <option value="all">Все</option>
        </select>
        <button type="button" onClick={() => void loadReports().catch((e) => {
          const msg = e instanceof Error ? e.message : String(e);
          setLoadError(msg);
          onError(msg);
        })}>Обновить</button>
        <span className="muted">Всего: {total}</span>
      </div>
      {loadError ? <div className="banner err">{loadError}</div> : null}
      {!loadError && reports.length === 0 ? (
        <p className="muted">Жалоб нет. Если вы только что отправили жалобу из чата — нажмите «Обновить» или проверьте фильтр «Все».</p>
      ) : null}
      <div className={`reports-layout${selected ? " reports-layout--split" : ""}`}>
        <div className="reports-layout__table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Время</th>
                <th>От кого</th>
                <th>Сообщение</th>
                <th>Статус</th>
              </tr>
            </thead>
            <tbody>
              {reports.map((r) => (
                <tr
                  key={r.id}
                  className={selected?.id === r.id ? "selected" : ""}
                  onClick={() => void openReport(r.id)}
                >
                  <td>{fmtDate(r.createdAtUtc)}</td>
                  <td>{r.reporterNickname}</td>
                  <td>{r.message?.text?.slice(0, 80) || "—"}</td>
                  <td>{r.status}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {selected ? (
          <div className="detail reports-layout__detail">
            <h3>Жалоба</h3>
            <dl>
              <dt>Статус</dt><dd>{selected.status}</dd>
              <dt>Причина</dt><dd>{selected.reason || "—"}</dd>
              <dt>Автор сообщения</dt><dd>{selected.message?.senderNickname}</dd>
              <dt>Канал</dt>
              <dd>
                {selected.message
                  ? formatChannelLabel({
                      name: selected.message.channelName,
                      kind: selected.message.channelKind,
                      serverName: selected.message.serverName,
                    })
                  : "—"}
              </dd>
            </dl>
            <div className="msg chat-msg">
              <div className="muted">{fmtDate(selected.message?.createdAtUtc)}</div>
              {selected.message ? <MessageBody m={selected.message} /> : <div className="muted">—</div>}
            </div>
            {selected.status === "pending" ? (
              <>
                {reportRootProtected ? (
                  <p className="mod-perms-hint muted">
                    Автор сообщения — root. Удаление, блокировка и мут недоступны модераторам платформы.
                  </p>
                ) : null}
                <textarea
                  placeholder="Комментарий модератора"
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                />
                <div className="mod-actions">
                  {canDeleteMsg ? (
                  <label className="mod-check">
                    <input type="checkbox" checked={deleteMsg} onChange={(e) => setDeleteMsg(e.target.checked)} />
                    <span>Удалить сообщение</span>
                  </label>
                  ) : null}

                  {canBan ? (
                  <label className="mod-check">
                    <input type="checkbox" checked={banUser} onChange={(e) => setBanUser(e.target.checked)} />
                    <span>Заблокировать автора на платформе</span>
                  </label>
                  ) : null}
                  {banUser && canBan ? (
                    <div className="mod-action-fields">
                      <input
                        placeholder="Причина блокировки аккаунта"
                        value={banReason}
                        onChange={(e) => setBanReason(e.target.value)}
                      />
                      <label className="pager-size">
                        <span className="muted small">Срок блокировки аккаунта</span>
                        <select
                          value={banMinutes}
                          onChange={(e) => setBanMinutes(Number(e.target.value))}
                        >
                          {banDurations.map((d) => (
                            <option key={d.minutes} value={d.minutes}>{d.label}</option>
                          ))}
                        </select>
                      </label>
                    </div>
                  ) : null}

                  {canMute ? (
                  <label className="mod-check">
                    <input type="checkbox" checked={muteChat} onChange={(e) => setMuteChat(e.target.checked)} />
                    <span>Временно заблокировать чат автору</span>
                  </label>
                  ) : null}
                  {muteChat && canMute ? (
                    <div className="mod-action-fields">
                      <input
                        placeholder="Причина блокировки чата"
                        value={chatMuteReason}
                        onChange={(e) => setChatMuteReason(e.target.value)}
                      />
                      <label className="pager-size">
                        <span className="muted small">Срок блокировки чата</span>
                        <select
                          value={chatMuteMinutes}
                          onChange={(e) => setChatMuteMinutes(Number(e.target.value))}
                        >
                          {CHAT_MUTE_DURATIONS.map((d) => (
                            <option key={d.minutes} value={d.minutes}>{d.label}</option>
                          ))}
                        </select>
                      </label>
                    </div>
                  ) : null}
                </div>
                <div className="row">
                  <button
                    type="button"
                    disabled={hasSelectedActions}
                    title={hasSelectedActions ? "Снимите отмеченные действия, чтобы отклонить жалобу" : undefined}
                    onClick={() => void resolve("dismissed")}
                  >
                    Отклонить
                  </button>
                  <button type="button" className="danger" onClick={() => void resolve("resolved")}>
                    Закрыть
                  </button>
                </div>
              </>
            ) : (
              <p className="muted">Обработано: {fmtDate(selected.resolvedAtUtc)}</p>
            )}
          </div>
        ) : null}
      </div>
    </section>
  );
}
