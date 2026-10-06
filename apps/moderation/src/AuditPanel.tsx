import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, type AuditEntry } from "./api";
import { ListPager } from "./ListPager";

const PAGE_SIZES = [10, 25, 50, 100, 250, 500] as const;

type SortField = "time" | "actor" | "action" | "target";
type SortDir = "asc" | "desc";

type ColumnId = "time" | "actor" | "action" | "target" | "details";

const DEFAULT_WIDTHS: Record<ColumnId, number> = {
  time: 150,
  actor: 140,
  action: 200,
  target: 280,
  details: 220,
};

const SORTABLE: Record<ColumnId, SortField | null> = {
  time: "time",
  actor: "actor",
  action: "action",
  target: "target",
  details: null,
};

function fmtDate(iso?: string | null): string {
  if (!iso) return "—";
  try {
    return new Intl.DateTimeFormat("ru-RU", { dateStyle: "short", timeStyle: "short" }).format(new Date(iso));
  } catch {
    return iso;
  }
}

type Props = {
  onError: (msg: string) => void;
  active?: boolean;
  refreshVersion?: number;
};

export function AuditPanel({ onError, active = true, refreshVersion = 0 }: Props) {
  const [items, setItems] = useState<AuditEntry[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState<number>(25);
  const [sortField, setSortField] = useState<SortField>("time");
  const [sortDir, setSortDir] = useState<SortDir>("desc");
  const [loading, setLoading] = useState(false);
  const [colWidths, setColWidths] = useState(DEFAULT_WIDTHS);
  const resizeRef = useRef<{ col: ColumnId; startX: number; startW: number } | null>(null);

  const totalPages = useMemo(() => Math.max(1, Math.ceil(total / pageSize) || 1), [total, pageSize]);

  const loadAudit = useCallback(async () => {
    setLoading(true);
    try {
      const skip = (page - 1) * pageSize;
      const params = new URLSearchParams({
        skip: String(skip),
        take: String(pageSize),
        sort: sortDir,
        sortBy: sortField,
      });
      const res = await api<{ items: AuditEntry[]; total: number }>(`/platform/audit?${params}`);
      setItems(res.items || []);
      setTotal(res.total || 0);
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [page, pageSize, sortDir, sortField, onError]);

  useEffect(() => {
    if (!active) return;
    void loadAudit();
  }, [active, loadAudit, refreshVersion]);

  useEffect(() => {
    setPage(1);
  }, [pageSize, sortField, sortDir]);

  const goToPage = (next: number) => {
    setPage(Math.min(totalPages, Math.max(1, next)));
  };

  const toggleSort = (col: ColumnId) => {
    const field = SORTABLE[col];
    if (!field) return;
    if (sortField === field) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortField(field);
      setSortDir(field === "time" ? "desc" : "asc");
    }
  };

  const sortIndicator = (col: ColumnId): string => {
    const field = SORTABLE[col];
    if (!field || sortField !== field) return "";
    return sortDir === "asc" ? " ▲" : " ▼";
  };

  const startResize = (col: ColumnId, e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    resizeRef.current = { col, startX: e.clientX, startW: colWidths[col] };

    const onMove = (ev: MouseEvent) => {
      const cur = resizeRef.current;
      if (!cur) return;
      const next = Math.max(72, cur.startW + ev.clientX - cur.startX);
      setColWidths((w) => ({ ...w, [cur.col]: next }));
    };

    const onUp = () => {
      resizeRef.current = null;
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
    };

    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  };

  const columns: { id: ColumnId; label: string }[] = [
    { id: "time", label: "Время" },
    { id: "actor", label: "Модератор" },
    { id: "action", label: "Действие" },
    { id: "target", label: "Цель" },
    { id: "details", label: "Детали" },
  ];

  return (
    <section className="panel panel--fill audit-panel">
      <div className="audit-head">
        <span className="muted">
          {total ? `${total} записей` : "0 записей"} · стр. {page}/{totalPages}
        </span>
        <label className="pager-size">
          <span className="muted small">На странице</span>
          <select
            value={pageSize}
            onChange={(e) => setPageSize(Number(e.target.value))}
            disabled={loading}
          >
            {PAGE_SIZES.map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </label>
      </div>

      <div className="audit-table-shell">
        <div className="audit-table-scroll">
          <table className="table table--resizable" style={{ tableLayout: "fixed", minWidth: "100%" }}>
            <colgroup>
              {columns.map((c) => (
                <col key={c.id} style={{ width: colWidths[c.id] }} />
              ))}
            </colgroup>
            <thead>
              <tr>
                {columns.map((c) => (
                  <th
                    key={c.id}
                    className={SORTABLE[c.id] ? "th-sortable" : undefined}
                    onClick={SORTABLE[c.id] ? () => toggleSort(c.id) : undefined}
                  >
                    <span className="th-label">
                      {c.label}
                      {sortIndicator(c.id)}
                    </span>
                    <span
                      className="col-resizer"
                      onMouseDown={(e) => startResize(c.id, e)}
                      onClick={(e) => e.stopPropagation()}
                      role="separator"
                      aria-orientation="vertical"
                      aria-label={`Ширина колонки «${c.label}»`}
                    />
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {loading && items.length === 0 ? (
                <tr>
                  <td colSpan={5} className="muted">
                    Загрузка…
                  </td>
                </tr>
              ) : null}
              {!loading && items.length === 0 ? (
                <tr>
                  <td colSpan={5} className="muted">
                    Записей нет
                  </td>
                </tr>
              ) : null}
              {items.map((a) => (
                <tr key={a.id}>
                  <td>{fmtDate(a.createdAtUtc)}</td>
                  <td>{a.actorNickname}</td>
                  <td>{a.actionLabel || a.action}</td>
                  <td title={a.targetId}>{a.targetLabel || a.targetId}</td>
                  <td title={a.details || ""}>{a.detailsLabel || a.details || "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <ListPager page={page} totalPages={totalPages} loading={loading} onGoToPage={goToPage} />
      </div>
    </section>
  );
}
