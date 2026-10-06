import { useCallback, useEffect, useMemo, useState } from "react";
import { api, type UserActivityEntry } from "./api";
import { ConfirmDialog } from "./ConfirmDialog";
import { ListPager } from "./ListPager";

const PAGE_SIZES = [25, 50, 100, 200, 500] as const;

type SortField = "time" | "action";
type SortDir = "asc" | "desc";

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
          <table className="table table--compact user-activity-table">
            <thead>
              <tr>
                <th className="th-sortable" onClick={() => toggleSort("time")}>
                  Время{sortIndicator("time")}
                </th>
                <th className="th-sortable" onClick={() => toggleSort("action")}>
                  Действие{sortIndicator("action")}
                </th>
                <th>Детали</th>
                {canViewIps ? <th>IP</th> : null}
              </tr>
            </thead>
            <tbody>
              {loading && items.length === 0 ? (
                <tr>
                  <td colSpan={canViewIps ? 4 : 3} className="muted">
                    Загрузка…
                  </td>
                </tr>
              ) : null}
              {!loading && items.length === 0 ? (
                <tr>
                  <td colSpan={canViewIps ? 4 : 3} className="muted">
                    Записей нет
                  </td>
                </tr>
              ) : null}
              {items.map((row) => (
                <tr key={row.id}>
                  <td className="user-activity-table__time">{fmtDate(row.createdAtUtc)}</td>
                  <td title={row.action}>{row.actionLabel || row.action}</td>
                  <td className="user-activity-table__details" title={row.details || ""}>
                    {row.detailsLabel || row.details || "—"}
                  </td>
                  {canViewIps ? (
                    <td className="user-activity-table__ip muted small">{row.ipAddress || "—"}</td>
                  ) : null}
                </tr>
              ))}
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
