import { useCallback, useEffect, useState } from "react";

type UpdateProgress =
  | { phase: "preparing" }
  | { phase: "downloading"; loaded: number; total: number | null; percent: number | null; bps?: number | null; etaSeconds?: number | null }
  | { phase: "installing" }
  | { phase: "prompt_install" }
  | { phase: "done" }
  | { phase: "error"; message: string };

function isProgress(x: unknown): x is UpdateProgress {
  if (!x || typeof x !== "object") return false;
  const p = x as { phase?: string };
  return (
    p.phase === "preparing" ||
    p.phase === "downloading" ||
    p.phase === "installing" ||
    p.phase === "prompt_install" ||
    p.phase === "done" ||
    p.phase === "error"
  );
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} Б`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} КБ`;
  return `${(n / (1024 * 1024)).toFixed(1)} МБ`;
}

function formatSpeed(bps: number): string {
  const mbps = (bps * 8) / (1024 * 1024);
  if (mbps >= 10) return `${mbps.toFixed(0)} Мбит/с`;
  if (mbps >= 1) return `${mbps.toFixed(1)} Мбит/с`;
  if (mbps >= 0.1) return `${mbps.toFixed(2)} Мбит/с`;
  const kbps = (bps * 8) / 1024;
  return `${kbps.toFixed(0)} Кбит/с`;
}

function formatEta(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const m = Math.floor(s / 60);
  const r = s % 60;
  if (m <= 0) return `${r}с`;
  return `${m}м ${String(r).padStart(2, "0")}с`;
}

/**
 * Экран загрузки и тихой установки обновления (только в Electron, события из main).
 */
export function ElectronUpdateOverlay() {
  const [progress, setProgress] = useState<UpdateProgress | null>(null);
  const [speedHint, setSpeedHint] = useState<string>("");

  const dismiss = useCallback(() => {
    setProgress(null);
  }, []);

  useEffect(() => {
    if (typeof window === "undefined" || !window.sloncord?.onUpdateProgress) return;
    return window.sloncord.onUpdateProgress((detail: unknown) => {
      if (!isProgress(detail)) return;
      if (detail.phase === "preparing" || detail.phase === "downloading" || detail.phase === "installing") {
        setProgress(detail);
        if (detail.phase === "downloading") {
          const bps = typeof detail.bps === "number" ? detail.bps : null;
          const eta = typeof detail.etaSeconds === "number" ? detail.etaSeconds : null;
          if (bps && bps > 0) {
            setSpeedHint(`${formatSpeed(bps)}${eta != null ? ` • осталось ~${formatEta(eta)}` : ""}`);
          } else {
            setSpeedHint("");
          }
        } else {
          setSpeedHint("");
        }
        return;
      }
      if (detail.phase === "done" || detail.phase === "prompt_install") {
        setProgress(null);
        setSpeedHint("");
        return;
      }
      if (detail.phase === "error") {
        setProgress(detail);
        setSpeedHint("");
      }
    });
  }, []);

  if (!progress) return null;

  if (progress.phase === "error") {
    return (
      <div className="electron-update-overlay" role="alertdialog" aria-modal="true" aria-live="assertive">
        <div className="electron-update-overlay__card">
          <h2 className="electron-update-overlay__title">Не удалось обновить</h2>
          <p className="electron-update-overlay__message">{progress.message}</p>
          <button type="button" className="electron-update-overlay__btn" onClick={dismiss}>
            Закрыть
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="electron-update-overlay" role="status" aria-live="polite" aria-busy="true">
      <div className="electron-update-overlay__card">
        <img
          className="electron-update-overlay__logo"
          src="./icons/sloncord.svg"
          alt=""
          width={64}
          height={64}
          draggable={false}
        />
        {progress.phase === "preparing" ? (
          <p className="electron-update-overlay__line">Подготовка к обновлению…</p>
        ) : null}
        {progress.phase === "downloading" ? (
          <>
            <p className="electron-update-overlay__line">Скачивание обновления…</p>
            {progress.total != null ? (
              <p className="electron-update-overlay__sub">
                {formatBytes(progress.loaded)} из {formatBytes(progress.total)}
              </p>
            ) : null}
            {speedHint ? <p className="electron-update-overlay__sub">{speedHint}</p> : null}
            <div className="electron-update-overlay__bar-wrap">
              {progress.percent != null ? (
                <div
                  className="electron-update-overlay__bar"
                  style={{ width: `${Math.max(0, Math.min(100, progress.percent))}%` }}
                />
              ) : (
                <div className="electron-update-overlay__bar electron-update-overlay__bar--indeterminate" />
              )}
            </div>
          </>
        ) : null}
        {progress.phase === "installing" ? (
          <>
            <p className="electron-update-overlay__line">Установка и перезапуск…</p>
            <p className="electron-update-overlay__sub">
              Приложение сейчас закроется. После установки Sloncord запустится снова.
            </p>
            <div className="electron-update-overlay__spinner" aria-hidden="true" />
          </>
        ) : null}
      </div>
    </div>
  );
}
