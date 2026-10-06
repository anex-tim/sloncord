import { useCallback, useEffect, useMemo, useState } from "react";
import { api, type ServerLogEntry } from "./api";
import { ListPager } from "./ListPager";

const PAGE_SIZES = [25, 50, 100, 250, 500] as const;

function fmtDate(iso?: string | null): string {
  if (!iso) return "—";
  try {
    return new Intl.DateTimeFormat("ru-RU", { dateStyle: "short", timeStyle: "medium" }).format(new Date(iso));
  } catch {
    return iso;
  }
}

type Props = {
  onError: (msg: string) => void;
  active?: boolean;
};

export function ServerLogsPanel({ onError, active = true }: Props) {
  const [items, setItems] = useState<ServerLogEntry[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState<number>(50);
  const [level, setLevel] = useState("");
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(false);

  const totalPages = useMemo(() => Math.max(1, Math.ceil(total / pageSize) || 1), [total, pageSize]);

  const loadLogs = useCallback(async () => {
    setLoading(true);
    try {
      const skip = (page - 1) * pageSize;
      const params = new URLSearchParams({
        skip: String(skip),
        take: String(pageSize),
      });
      if (level) params.set("level", level);
      if (query.trim()) params.set("q", query.trim());
      const res = await api<{ items: ServerLogEntry[]; total: number }>(`/platform/server-logs?${params}`);
      setItems(res.items || []);
      setTotal(res.total || 0);
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [page, pageSize, level, query, onError]);

  useEffect(() => {
    if (!active) return;
    void loadLogs();
  }, [active, loadLogs]);

  return (
    <section className="panel panel--fill server-logs-panel">
      <div className="row reports-toolbar">
        <select value={level} onChange={(e) => { setLevel(e.target.value); setPage(1); }}>
          <option value="">Все уровни</option>
          <option value="error">Ошибки</option>
          <option value="warning">Предупреждения</option>
          <option value="information">Информация</option>
        </select>
        <input
          placeholder="Поиск в логах"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && void loadLogs()}
        />
        <button type="button" onClick={() => void loadLogs()} disabled={loading}>Обновить</button>
        <span className="muted">Всего: {total}</span>
      </div>
      <div className="server-logs-list">
        {loading && items.length === 0 ? <div className="muted">Загрузка…</div> : null}
        {items.map((row, idx) => (
          <div key={`${row.createdAtUtc}-${idx}`} className={`server-log server-log--${row.level}`}>
            <div className="server-log__head">
              <span className="server-log__time">{fmtDate(row.createdAtUtc)}</span>
              <span className="server-log__level">{row.level}</span>
              <span className="server-log__category muted">{row.category}</span>
            </div>
            <div className="server-log__message">{row.message}</div>
            {row.exception ? (
              <pre className="server-log__exception">{row.exception}</pre>
            ) : null}
          </div>
        ))}
        {!loading && items.length === 0 ? <div className="muted">Записей нет</div> : null}
      </div>
      <div className="row">
        <label className="pager-size">
          <span className="muted small">На странице</span>
          <select
            value={pageSize}
            onChange={(e) => { setPageSize(Number(e.target.value)); setPage(1); }}
            disabled={loading}
          >
            {PAGE_SIZES.map((n) => (
              <option key={n} value={n}>{n}</option>
            ))}
          </select>
        </label>
      </div>
      <ListPager page={page} totalPages={totalPages} loading={loading} onGoToPage={setPage} />
    </section>
  );
}
