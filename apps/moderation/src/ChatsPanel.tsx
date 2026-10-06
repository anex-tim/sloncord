import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  api,
  formatChannelLabel,
  type PlatformChannel,
  type PlatformMessageHit,
  type PlatformServer,
} from "./api";
import { ListPager } from "./ListPager";
import { MessageBody } from "./MessageBody";
import { canModerateMessage, hasPerm, type PlatformMe } from "./platformPerms";

const PAGE_SIZES = [10, 25, 50, 100, 250, 500] as const;
type MessageSort = "desc" | "asc";

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
};

export function ChatsPanel({ me, onError, onStatus }: Props) {
  const [servers, setServers] = useState<PlatformServer[]>([]);
  const [channels, setChannels] = useState<PlatformChannel[]>([]);
  const [serverFilter, setServerFilter] = useState("");
  const [channelFilter, setChannelFilter] = useState("");
  const [selectedServerId, setSelectedServerId] = useState("");
  const [selectedChannelId, setSelectedChannelId] = useState("");
  const [selectedChannel, setSelectedChannel] = useState<PlatformChannel | null>(null);
  const [messages, setMessages] = useState<PlatformMessageHit[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState<number>(25);
  const [messageSort, setMessageSort] = useState<MessageSort>("desc");
  const [loading, setLoading] = useState(false);
  const listRef = useRef<HTMLDivElement | null>(null);

  const totalPages = useMemo(() => Math.max(1, Math.ceil(total / pageSize) || 1), [total, pageSize]);

  const loadServers = useCallback(async () => {
    const res = await api<{ items: PlatformServer[] }>("/platform/servers?take=200");
    setServers(res.items || []);
  }, []);

  const loadChannels = useCallback(async (serverId: string, q: string) => {
    const params = new URLSearchParams({ take: "300" });
    if (serverId) params.set("serverId", serverId);
    if (q.trim()) params.set("q", q.trim());
    const res = await api<{ items: PlatformChannel[] }>(`/platform/channels?${params}`);
    setChannels(res.items || []);
  }, []);

  const loadMessagesPage = useCallback(
    async (channelId: string, nextPage: number, size: number, sort: MessageSort) => {
      setLoading(true);
      try {
        const skip = (nextPage - 1) * size;
        const res = await api<{
          messages: PlatformMessageHit[];
          total: number;
          page?: number;
          totalPages?: number;
        }>(`/platform/channels/${channelId}/messages?limit=${size}&skip=${skip}&sort=${sort}`);
        setMessages(res.messages || []);
        setTotal(res.total ?? 0);
        setPage(res.page ?? nextPage);
        requestAnimationFrame(() => {
          listRef.current?.scrollTo({ top: 0 });
        });
      } catch (e) {
        onError(e instanceof Error ? e.message : String(e));
      } finally {
        setLoading(false);
      }
    },
    [onError]
  );

  useEffect(() => {
    void loadServers().catch((e) => onError(e instanceof Error ? e.message : String(e)));
  }, [loadServers, onError]);

  useEffect(() => {
    void loadChannels(selectedServerId, channelFilter).catch((e) =>
      onError(e instanceof Error ? e.message : String(e))
    );
  }, [selectedServerId, channelFilter, loadChannels, onError]);

  useEffect(() => {
    if (!selectedChannelId) return;
    void loadMessagesPage(selectedChannelId, 1, pageSize, messageSort);
  }, [selectedChannelId, pageSize, messageSort, loadMessagesPage]);

  const openChannel = (ch: PlatformChannel) => {
    setSelectedChannelId(ch.id);
    setSelectedChannel(ch);
    setPage(1);
  };

  const goToPage = (nextPage: number) => {
    if (!selectedChannelId || nextPage < 1 || nextPage > totalPages || loading) return;
    void loadMessagesPage(selectedChannelId, nextPage, pageSize, messageSort);
  };

  const deleteMessage = async (messageId: string) => {
    if (!confirm("Удалить сообщение?")) return;
    try {
      await api(`/platform/messages/${messageId}`, { method: "DELETE" });
      setMessages((prev) =>
        prev.map((m) => (m.id === messageId ? { ...m, isDeleted: true, text: "" } : m))
      );
      onStatus("Сообщение удалено");
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e));
    }
  };

  const filteredServers = servers.filter((s) =>
    !serverFilter.trim() || s.name.toLowerCase().includes(serverFilter.trim().toLowerCase())
  );

  return (
    <section className="panel panel--fill chats-panel">
      <div className="chats-layout">
        <aside className="chats-sidebar">
          <input
            placeholder="Фильтр серверов"
            value={serverFilter}
            onChange={(e) => setServerFilter(e.target.value)}
          />
          <div className="chats-list">
            <button
              type="button"
              className={!selectedServerId ? "chats-pick active" : "chats-pick"}
              onClick={() => setSelectedServerId("")}
            >
              Все серверы
            </button>
            {filteredServers.map((s) => (
              <button
                key={s.id}
                type="button"
                className={selectedServerId === s.id ? "chats-pick active" : "chats-pick"}
                onClick={() => setSelectedServerId(s.id)}
              >
                {s.name}
              </button>
            ))}
          </div>
          <input
            placeholder="Поиск канала"
            value={channelFilter}
            onChange={(e) => setChannelFilter(e.target.value)}
          />
          <div className="chats-list chats-list--channels">
            {channels.map((ch) => (
              <button
                key={ch.id}
                type="button"
                className={selectedChannelId === ch.id ? "chats-pick active" : "chats-pick"}
                onClick={() => openChannel(ch)}
              >
                {formatChannelLabel(ch)}
              </button>
            ))}
          </div>
        </aside>

        <div className="chats-main">
          {selectedChannel ? (
            <>
              <div className="chats-main-head">
                <div>
                  <strong>
                    {formatChannelLabel(selectedChannel)}
                  </strong>
                  <div className="muted small">{selectedChannel.id}</div>
                </div>
                <div className="chats-head-controls">
                  <label className="pager-size">
                    <span className="muted small">Порядок</span>
                    <select
                      value={messageSort}
                      onChange={(e) => setMessageSort(e.target.value as MessageSort)}
                      disabled={loading}
                    >
                      <option value="desc">Сначала новые</option>
                      <option value="asc">Сначала старые</option>
                    </select>
                  </label>
                  <label className="pager-size">
                    <span className="muted small">На странице</span>
                    <select
                      value={pageSize}
                      onChange={(e) => setPageSize(Number(e.target.value))}
                      disabled={loading}
                    >
                      {PAGE_SIZES.map((n) => (
                        <option key={n} value={n}>{n}</option>
                      ))}
                    </select>
                  </label>
                  <span className="muted small">
                    {total ? `${total} сообщ.` : "0 сообщ."} · стр. {page}/{totalPages}
                  </span>
                </div>
              </div>
              <div className="chats-messages" ref={listRef}>
                {loading && messages.length === 0 ? (
                  <div className="muted">Загрузка…</div>
                ) : null}
                {messages.map((m) => (
                  <div key={m.id} className={`msg chat-msg${m.isDeleted ? " deleted" : ""}`}>
                    <div className="msg-meta">
                      <strong>{m.senderNickname}</strong>
                      <span className="muted">{fmtDate(m.createdAtUtc)}</span>
                      {!m.isDeleted && hasPerm(me, "deleteMessages") && canModerateMessage(me, m) ? (
                        <button type="button" className="ghost tiny" onClick={() => void deleteMessage(m.id)}>
                          удалить
                        </button>
                      ) : m.isDeleted ? (
                        <span className="badge bad">удалено</span>
                      ) : null}
                    </div>
                    <div><MessageBody m={m} /></div>
                  </div>
                ))}
                {!loading && messages.length === 0 ? (
                  <div className="muted">В канале нет сообщений</div>
                ) : null}
              </div>
              <ListPager page={page} totalPages={totalPages} loading={loading} onGoToPage={goToPage} />
            </>
          ) : (
            <div className="chats-empty muted">Выберите канал слева</div>
          )}
        </div>
      </div>
    </section>
  );
}
