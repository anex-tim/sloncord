import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, type UserActivityEntry } from "./api";
import { ConfirmDialog } from "./ConfirmDialog";
import { ListPager } from "./ListPager";

const PAGE_SIZES = [25, 50, 100, 200, 500] as const;

type SortField = "time" | "action";
type SortDir = "asc" | "desc";
type ColumnId = "time" | "action" | "details" | "ip";

const DEFAULT_WIDTHS: Record<ColumnId, number> = {
  time: 108,
  action: 96,
  details: 160,
  ip: 108,
};

type Props = {
  userId: string;
  canViewIps: boolean;
  canClear: boolean;
  fmtDate: (iso?: string | null) => string;
  onError: (msg: string) => void;
  onStatus: (msg: string) => void;
  onCleared?: () => void;
};

export function UserActivityPanel({
  userId,
  canViewIps,
  canClear,
  fmtDate,
  onError,
  onStatus,
  onCleared,
}: Props) {
  const [items, setItems] = useState<UserActivityEntry[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState<number>(50);
  const [sortField, setSortField] = useState<SortField>("time");
  const [sortDir, setSortDir] = useState<SortDir>("desc");
  const [actionFilter, setActionFilter] = useState("");
  const [loading, setLoading] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [clearConfirmOpen, setClearConfirmOpen] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [colWidths, setColWidths] = useState(DEFAULT_WIDTHS);
  const resizeRef = useRef<{ col: ColumnId; startX: number; startW: number } | null>(null);

  const totalPages = useMemo(() => Math.max(1, Math.ceil(total / pageSize) || 1), [total, pageSize]);

  const loadActivity = useCallback(async () => {
    setLoading(true);
    try {
      const skip = (page - 1) * pageSize;
      const params = new URLSearchParams({
        skip: String(skip),
        take: String(pageSize),
        sort: sortDir,
        sortBy: sortField,
      });
      if (actionFilter.trim()) params.set("action", actionFilter.trim());
      const res = await api<{ items: UserActivityEntry[]; total: number }>(
        `/platform/users/${userId}/activity?${params}`
      );
      setItems(res.items || []);
      setTotal(res.total || 0);
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [userId, page, pageSize, sortDir, sortField, actionFilter, onError]);

  useEffect(() => {
    setPage(1);
  }, [userId, pageSize, sortField, sortDir, actionFilter]);

  useEffect(() => {
    void loadActivity();
  }, [loadActivity]);

  const goToPage = (next: number) => {
    setPage(Math.min(totalPages, Math.max(1, next)));
  };

  const toggleSort = (field: SortField) => {
    if (sortField === field) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortField(field);
      setSortDir(field === "time" ? "desc" : "asc");
    }
  };

  const sortIndicator = (field: SortField): string => {
    if (sortField !== field) return "";
    return sortDir === "asc" ? " ▲" : " ▼";
  };

  const startResize = (col: ColumnId, e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    resizeRef.current = { col, startX: e.clientX, startW: colWidths[col] };
    const onMove = (ev: MouseEvent) => {
      const cur = resizeRef.current;
      if (!cur) return;
      const next = Math.max(64, cur.startW + ev.clientX - cur.startX);
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

  const columns: { id: ColumnId; label: string; sortable: boolean }[] = [
    { id: "time", label: "Время", sortable: true },
    { id: "action", label: "Действие", sortable: true },
    { id: "details", label: "Детали", sortable: false },
    ...(canViewIps ? [{ id: "ip" as const, label: "IP", sortable: false }] : []),
  ];

  const clearUserLog = async () => {
    setClearing(true);
    try {
      const res = await api<{ removed?: number }>(`/platform/users/${userId}/activity`, { method: "DELETE" });
      onStatus(`Журнал очищен (${res.removed ?? 0} записей)`);
      setPage(1);
      await loadActivity();
      onCleared?.();
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e));
    } finally {
      setClearing(false);
    }
  };

  return (
    <div className="user-activity-panel">
      <div className="user-activity-panel__head">
        <span className="muted small">
          {total ? `${total} записей` : "0 записей"} · стр. {page}/{totalPages}
        </span>
        <div className="user-activity-panel__controls">
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
          <input
            type="text"
            className="user-activity-filter"
            placeholder="Фильтр по action"
            value={actionFilter}
            onChange={(e) => setActionFilter(e.target.value)}
            title="Например: user.login, message.send"
          />
          {canClear ? (
            <button
              type="button"
              className="ghost tiny danger"
              disabled={clearing || loading || total === 0}
              onClick={() => setClearConfirmOpen(true)}
            >
              Очистить журнал
            </button>
          ) : null}
        </div>
      </div>

      <div className="user-activity-table-shell">
        <div className="user-activity-table-scroll">
          <table className="table table--compact table--resizable user-activity-table">
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
                    className={c.sortable ? "th-sortable" : undefined}
                    onClick={c.sortable ? () => toggleSort(c.id === "time" ? "time" : "action") : undefined}
                  >
                    <span className="th-label">
                      {c.label}
                      {c.id === "time" || c.id === "action" ? sortIndicator(c.id) : ""}
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
                  <td colSpan={columns.length} className="muted">
                    Загрузка…
                  </td>
                </tr>
              ) : null}
              {!loading && items.length === 0 ? (
                <tr>
                  <td colSpan={columns.length} className="muted">
                    Записей нет
                  </td>
                </tr>
              ) : null}
              {items.map((row) => {
                const details = row.detailsLabel || row.details || "—";
                const open = expandedId === row.id;
                return (
                  <Fragment key={row.id}>
                    <tr
                      className={open ? "is-open" : undefined}
                      onClick={() => setExpandedId((id) => (id === row.id ? null : row.id))}
                    >
                      <td className="user-activity-table__time">{fmtDate(row.createdAtUtc)}</td>
                      <td title={row.action}>{row.actionLabel || row.action}</td>
                      <td className="user-activity-table__details">{details}</td>
                      {canViewIps ? (
                        <td className="user-activity-table__ip muted small">{row.ipAddress || "—"}</td>
                      ) : null}
                    </tr>
                    {open ? (
                      <tr key={`${row.id}-full`} className="user-activity-table__full">
                        <td colSpan={columns.length}>
                          <div className="user-activity-full__action">{row.actionLabel || row.action}</div>
                          <div className="user-activity-full__details">{details}</div>
                          {canViewIps ? (
                            <div className="muted small">IP: {row.ipAddress || "—"}</div>
                          ) : null}
                        </td>
                      </tr>
                    ) : null}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
        <ListPager page={page} totalPages={totalPages} loading={loading} onGoToPage={goToPage} />
      </div>
      <ConfirmDialog
        open={clearConfirmOpen}
        message="Удалить весь журнал действий этого пользователя? Это действие необратимо."
        confirmLabel="Очистить"
        onConfirm={() => {
          setClearConfirmOpen(false);
          void clearUserLog();
        }}
        onCancel={() => setClearConfirmOpen(false)}
      />
    </div>
  );
}
