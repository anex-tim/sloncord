import { useEffect, useMemo, useRef, useState } from "react";
import { buildPageItems } from "./pagerUtils";

type Props = {
  page: number;
  totalPages: number;
  loading?: boolean;
  onGoToPage: (page: number) => void;
};

export function ListPager({ page, totalPages, loading = false, onGoToPage }: Props) {
  const [pageJumpOpen, setPageJumpOpen] = useState(false);
  const [pageJumpInput, setPageJumpInput] = useState("");
  const pageJumpRef = useRef<HTMLInputElement | null>(null);
  const pageItems = useMemo(() => buildPageItems(page, totalPages), [page, totalPages]);

  useEffect(() => {
    if (pageJumpOpen) pageJumpRef.current?.focus();
  }, [pageJumpOpen]);

  const openPageJump = () => {
    setPageJumpInput(String(page));
    setPageJumpOpen(true);
  };

  const submitPageJump = () => {
    const n = Number.parseInt(pageJumpInput, 10);
    if (!Number.isFinite(n)) return;
    const clamped = Math.min(totalPages, Math.max(1, n));
    onGoToPage(clamped);
    setPageJumpOpen(false);
  };

  if (totalPages <= 1) return null;

  return (
    <div className="pager">
      <button
        type="button"
        className="ghost tiny pager-arrow"
        disabled={loading || page <= 1}
        onClick={() => onGoToPage(page - 1)}
      >
        ←
      </button>
      {pageItems.map((item, idx) =>
        item === "…" ? (
          <button
            key={`e-${idx}`}
            type="button"
            className="pager-ellipsis ghost tiny"
            disabled={loading}
            title="Перейти на страницу…"
            onClick={openPageJump}
          >
            …
          </button>
        ) : (
          <button
            key={item}
            type="button"
            className={`pager-num tiny${item === page ? " active" : " ghost"}`}
            disabled={loading}
            onClick={() => onGoToPage(item)}
          >
            {item}
          </button>
        )
      )}
      <button
        type="button"
        className="ghost tiny pager-arrow"
        disabled={loading || page >= totalPages}
        onClick={() => onGoToPage(page + 1)}
      >
        →
      </button>
      {pageJumpOpen ? (
        <form
          className="pager-jump"
          onSubmit={(e) => {
            e.preventDefault();
            submitPageJump();
          }}
        >
          <input
            ref={pageJumpRef}
            className="pager-jump-input"
            type="number"
            min={1}
            max={totalPages}
            value={pageJumpInput}
            onChange={(e) => setPageJumpInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                e.preventDefault();
                setPageJumpOpen(false);
              }
            }}
            aria-label={`Номер страницы от 1 до ${totalPages}`}
          />
          <button type="submit" className="tiny" disabled={loading}>
            OK
          </button>
          <button
            type="button"
            className="ghost tiny"
            onClick={() => setPageJumpOpen(false)}
            aria-label="Отмена"
          >
            ×
          </button>
        </form>
      ) : null}
    </div>
  );
}
