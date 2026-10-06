import { useCallback, useEffect, useState } from "react";
import {
  fetchDesktopReleaseFromGithub,
  pickNewestDesktopRelease,
  type DesktopReleaseMeta,
} from "./config/desktopGithubRelease";

type DesktopReleaseMeta = {
  version?: string;
  downloadUrl?: string;
};

/** Сравнение semver вида x.y.z (без prerelease). */

/** Первый запрос после старта (даёт время preload / сохранённому API base). */
const DESKTOP_FIRST_POLL_DELAY_MS = 900;
const DESKTOP_POLL_INTERVAL_MS = 5 * 60 * 1000;
const DESKTOP_STARTUP_RETRY_DELAYS_MS = [0, 8000, 45000];

/** Без постоянного интервала: проверка по событию (SignalR и т.п.), см. App.tsx. */
export const DESKTOP_RELEASE_CHECK_EVENT = "sloncord:desktop-release-check";

function isRemoteVersionNewer(remote: string, local: string): boolean {
  const pa = remote.split(".").map((x) => parseInt(x, 10));
  const pb = local.split(".").map((x) => parseInt(x, 10));
  const n = Math.max(pa.length, pb.length);
  for (let i = 0; i < n; i += 1) {
    const a = Number.isFinite(pa[i]) ? pa[i] : 0;
    const b = Number.isFinite(pb[i]) ? pb[i] : 0;
    if (a > b) return true;
    if (a < b) return false;
  }
  return false;
}

export function ElectronTitleBar() {
  const electron =
    typeof window !== "undefined" &&
    window.sloncord?.minimizeWindow &&
    window.sloncord?.getAppVersion &&
    window.sloncord?.installDesktopUpdate;

  const [localVersion, setLocalVersion] = useState("");
  const [remoteVersion, setRemoteVersion] = useState<string | null>(null);
  const [downloadUrl, setDownloadUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [winState, setWinState] = useState<{ maximized: boolean; fullscreen: boolean }>({ maximized: false, fullscreen: false });

  useEffect(() => {
    if (!electron) return;
    let off: (() => void) | null = null;
    void (async () => {
      try {
        const s = await window.sloncord?.getWindowState?.();
        if (s) setWinState({ maximized: !!s.maximized, fullscreen: !!s.fullscreen });
      } catch {
        /* ignore */
      }
    })();
    try {
      off = window.sloncord?.onWindowStateChanged?.((s) => {
        setWinState({ maximized: !!s.maximized, fullscreen: !!s.fullscreen });
      }) as any;
    } catch {
      off = null;
    }
    return () => {
      try { off?.(); } catch { /* ignore */ }
    };
  }, [electron]);

  useEffect(() => {
    if (!electron) return;
    let cancelled = false;
    void (async () => {
      try {
        const v = await window.sloncord!.getAppVersion!();
        if (!cancelled) setLocalVersion(String(v || "").trim());
      } catch {
        /* ignore */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [electron]);

  /**
   * Проверка обновлений на GitHub Releases (не VPS).
   */
  useEffect(() => {
    if (!electron || !localVersion) return;

    let cancelled = false;

    async function fetchDesktopRelease(signal: AbortSignal): Promise<void> {
      if (cancelled) return;
      try {
        const candidates: DesktopReleaseMeta[] = [];
        if (window.sloncord?.fetchDesktopReleaseFromMain) {
          try {
            const fromMain = (await window.sloncord.fetchDesktopReleaseFromMain()) as DesktopReleaseMeta | null;
            if (fromMain?.version && fromMain?.downloadUrl) candidates.push(fromMain);
          } catch {
            /* ignore */
          }
        }
        try {
          const fromRenderer = await fetchDesktopReleaseFromGithub(signal);
          if (fromRenderer?.version && fromRenderer?.downloadUrl) candidates.push(fromRenderer);
        } catch {
          /* ignore */
        }
        const data = pickNewestDesktopRelease(candidates);
        if (cancelled || !data) return;
        const rv = String(data?.version ?? "").trim();
        const du = String(data?.downloadUrl ?? "").trim();
        if (!rv || !du) return;
        setRemoteVersion(rv);
        setDownloadUrl(du);
      } catch {
        /* offline / abort */
      }
    }

    function runOnePoll(): void {
      if (cancelled) return;
      const ac = new AbortController();
      const timeoutMs = 15000;
      const t = window.setTimeout(() => {
        try {
          ac.abort();
        } catch {
          /* ignore */
        }
      }, timeoutMs);

      void fetchDesktopRelease(ac.signal).finally(() => {
        try {
          clearTimeout(t);
        } catch {
          /* ignore */
        }
      });
    }

    const t0 = window.setTimeout(runOnePoll, DESKTOP_FIRST_POLL_DELAY_MS);
    const startupRetryTimers: number[] = [];
    for (const delay of DESKTOP_STARTUP_RETRY_DELAYS_MS) {
      if (delay <= DESKTOP_FIRST_POLL_DELAY_MS) continue;
      startupRetryTimers.push(window.setTimeout(runOnePoll, delay));
    }
    const intervalId = window.setInterval(runOnePoll, DESKTOP_POLL_INTERVAL_MS);

    const onVisible = (): void => {
      if (document.visibilityState !== "visible" || cancelled) return;
      runOnePoll();
    };
    document.addEventListener("visibilitychange", onVisible);

    const onFocus = (): void => {
      if (cancelled) return;
      runOnePoll();
    };
    window.addEventListener("focus", onFocus);

    const onReleaseCheckEvent = (): void => {
      if (cancelled) return;
      runOnePoll();
    };
    window.addEventListener(DESKTOP_RELEASE_CHECK_EVENT, onReleaseCheckEvent);

    return () => {
      cancelled = true;
      try {
        clearTimeout(t0);
        clearInterval(intervalId);
        for (const id of startupRetryTimers) clearTimeout(id);
      } catch {
        /* ignore */
      }
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", onFocus);
      window.removeEventListener(DESKTOP_RELEASE_CHECK_EVENT, onReleaseCheckEvent);
    };
  }, [electron, localVersion]);

  const updateAvailable =
    !!remoteVersion &&
    !!localVersion &&
    !!downloadUrl &&
    isRemoteVersionNewer(remoteVersion, localVersion);

  const onDownload = useCallback(async () => {
    if (!downloadUrl || !window.sloncord?.installDesktopUpdate || busy) return;
    setBusy(true);
    try {
      let url = String(downloadUrl || "");
      try {
        if (remoteVersion) {
          const u = new URL(url);
          u.searchParams.set("v", String(remoteVersion));
          url = u.href;
        }
      } catch {
        // ignore
      }
      const r = await window.sloncord.installDesktopUpdate(url);
      if (!r.ok && r.error) {
        window.alert(r.error);
      }
    } finally {
      setBusy(false);
    }
  }, [busy, downloadUrl, remoteVersion]);

  if (!electron) return null;

  const showUpdate = updateAvailable;

  const titleText = localVersion ? `Sloncord - ${localVersion}` : "Sloncord";

  return (
    <header className="electron-titlebar">
      <div className="electron-titlebar__drag">
        <div className="electron-titlebar__brand">
          <img
            className="electron-titlebar__logo"
            src="./icons/sloncord.svg"
            alt=""
            width={20}
            height={20}
            draggable={false}
          />
          <span className="electron-titlebar__title">{titleText}</span>
        </div>
      </div>
      <div className="electron-titlebar__controls">
        {showUpdate ? (
          <button
            type="button"
            className="electron-titlebar__btn electron-titlebar__btn--update"
            disabled={busy}
            title={`Доступна версия ${remoteVersion}. Скачать и установить обновление.`}
            aria-label="Установить обновление"
            onClick={() => void onDownload()}
          >
            <svg className="electron-titlebar__icon" viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
              <path
                fill="currentColor"
                d="M11 3v10.17l-3.59-3.58L6 11l6 6 6-6-1.41-1.41L13 13.17V3h-2zm-8 18h18v2H3v-2z"
              />
            </svg>
          </button>
        ) : null}
        <button
          type="button"
          className="electron-titlebar__btn"
          title="Свернуть"
          aria-label="Свернуть"
          onClick={() => window.sloncord?.minimizeWindow?.()}
        >
          <svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true">
            <rect x="1" y="5.25" width="10" height="1.5" rx="0.5" fill="currentColor" />
          </svg>
        </button>
        <button
          type="button"
          className="electron-titlebar__btn"
          title="Развернуть / восстановить"
          aria-label="Развернуть или восстановить окно"
          onClick={() => {
            if (winState.fullscreen) {
              void window.sloncord?.setWindowFullscreen?.(false);
              return;
            }
            void window.sloncord?.maximizeWindowToggle?.();
          }}
        >
          {winState.maximized || winState.fullscreen ? (
            <svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true">
              <path
                fill="none"
                stroke="currentColor"
                strokeWidth="1.1"
                d="M3.2 4.2h4.6v4.6H3.2V4.2zm1-1h4.6v4.6"
              />
              <path fill="currentColor" d="M7.8 3.2h1v1h-1z" opacity="0.9" />
            </svg>
          ) : (
            <svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true">
              <rect x="2" y="2" width="8" height="8" rx="1" fill="none" stroke="currentColor" strokeWidth="1.25" />
            </svg>
          )}
        </button>
        <button
          type="button"
          className="electron-titlebar__btn electron-titlebar__btn--close"
          title="Закрыть"
          aria-label="Закрыть"
          onClick={() => window.sloncord?.closeWindow?.()}
        >
          <svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true">
            <path
              stroke="currentColor"
              strokeWidth="1.35"
              strokeLinecap="round"
              d="M3 3l6 6M9 3L3 9"
            />
          </svg>
        </button>
      </div>
    </header>
  );
}
