import { useCallback, useEffect, useState } from "react";
import {
  fetchModerationReleaseFromGithub,
  pickNewestModerationRelease,
  type ModerationReleaseMeta,
} from "./moderationGithubRelease";

type ReleaseMeta = {
  version?: string;
  downloadUrl?: string;
};

const FIRST_POLL_DELAY_MS = 800;
const POLL_INTERVAL_MS = 45 * 1000;
const STARTUP_RETRY_DELAYS_MS = [4000, 12000];
export const MODERATION_RELEASE_CHECK_EVENT = "slonmod:release-check";

function isRemoteVersionNewer(remote: string, local: string): boolean {
  const pa = remote.replace(/^v/i, "").split(".").map((x) => parseInt(x, 10));
  const pb = local.replace(/^v/i, "").split(".").map((x) => parseInt(x, 10));
  const n = Math.max(pa.length, pb.length);
  for (let i = 0; i < n; i += 1) {
    const a = Number.isFinite(pa[i]) ? pa[i] : 0;
    const b = Number.isFinite(pb[i]) ? pb[i] : 0;
    if (a > b) return true;
    if (a < b) return false;
  }
  return false;
}

export function ModerationTitleBar() {
  const electron =
    typeof window !== "undefined" &&
    window.slonmod?.minimizeWindow &&
    window.slonmod?.getAppVersion &&
    window.slonmod?.installUpdate;

  const [localVersion, setLocalVersion] = useState("");
  const [remoteVersion, setRemoteVersion] = useState<string | null>(null);
  const [downloadUrl, setDownloadUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [winState, setWinState] = useState<{ maximized: boolean; fullscreen: boolean }>({
    maximized: false,
    fullscreen: false,
  });

  useEffect(() => {
    if (!electron) return;
    let off: (() => void) | null = null;
    void (async () => {
      try {
        const s = await window.slonmod?.getWindowState?.();
        if (s) setWinState({ maximized: !!s.maximized, fullscreen: !!s.fullscreen });
      } catch {
        /* ignore */
      }
    })();
    try {
      off = window.slonmod?.onWindowStateChanged?.((s) => {
        setWinState({ maximized: !!s.maximized, fullscreen: !!s.fullscreen });
      }) as (() => void) | null;
    } catch {
      off = null;
    }
    return () => {
      try {
        off?.();
      } catch {
        /* ignore */
      }
    };
  }, [electron]);

  useEffect(() => {
    if (!electron) return;
    let cancelled = false;
    void (async () => {
      try {
        const v = await window.slonmod!.getAppVersion!();
        if (!cancelled) setLocalVersion(String(v || "").trim());
      } catch {
        /* ignore */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [electron]);

  useEffect(() => {
    if (!electron || !localVersion) return;

    let cancelled = false;

    async function poll(signal: AbortSignal): Promise<void> {
      if (cancelled) return;
      try {
        const fromMainPromise = Promise.race([
          window.slonmod?.fetchRelease?.().catch(() => null) ?? Promise.resolve(null),
          new Promise<ReleaseMeta | null>((resolve) => {
            window.setTimeout(() => resolve(null), 7000);
          }),
        ]);
        const [fromMain, fromRenderer] = await Promise.all([
          fromMainPromise,
          fetchModerationReleaseFromGithub(signal).catch(() => null),
        ]);
        const candidates: ModerationReleaseMeta[] = [];
        if (fromMain?.version && fromMain?.downloadUrl) candidates.push(fromMain);
        if (fromRenderer?.version && fromRenderer?.downloadUrl) candidates.push(fromRenderer);
        const data = pickNewestModerationRelease(candidates);
        if (cancelled || !data) return;
        const rv = String(data.version ?? "").trim();
        const du = String(data.downloadUrl ?? "").trim();
        if (!rv || !du.startsWith("http")) return;
        setRemoteVersion(rv);
        setDownloadUrl(du);
      } catch {
        /* offline / abort */
      }
    }

    function runOnePoll(): void {
      if (cancelled) return;
      const ac = new AbortController();
      const timer = window.setTimeout(() => {
        try {
          ac.abort();
        } catch {
          /* ignore */
        }
      }, 15000);
      void poll(ac.signal).finally(() => {
        try {
          clearTimeout(timer);
        } catch {
          /* ignore */
        }
      });
    }

    const t0 = window.setTimeout(runOnePoll, FIRST_POLL_DELAY_MS);
    const startupRetryTimers = STARTUP_RETRY_DELAYS_MS.map((delay) => window.setTimeout(runOnePoll, delay));
    const intervalId = window.setInterval(runOnePoll, POLL_INTERVAL_MS);
    const onVisible = (): void => {
      if (document.visibilityState === "visible") runOnePoll();
    };
    const onFocus = (): void => {
      runOnePoll();
    };
    const onReleaseCheck = (): void => {
      runOnePoll();
    };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", onFocus);
    window.addEventListener(MODERATION_RELEASE_CHECK_EVENT, onReleaseCheck);
    return () => {
      cancelled = true;
      clearTimeout(t0);
      clearInterval(intervalId);
      for (const id of startupRetryTimers) clearTimeout(id);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", onFocus);
      window.removeEventListener(MODERATION_RELEASE_CHECK_EVENT, onReleaseCheck);
    };
  }, [electron, localVersion]);

  const updateAvailable =
    !!remoteVersion &&
    !!localVersion &&
    !!downloadUrl &&
    isRemoteVersionNewer(remoteVersion, localVersion);

  const onDownload = useCallback(async () => {
    if (!downloadUrl || !window.slonmod?.installUpdate || busy) return;
    setBusy(true);
    try {
      let url = downloadUrl;
      if (remoteVersion) {
        try {
          const u = new URL(url);
          u.searchParams.set("v", remoteVersion);
          url = u.href;
        } catch {
          /* ignore */
        }
      }
      const r = await window.slonmod.installUpdate(url);
      if (!r.ok && r.error) window.alert(r.error);
    } finally {
      setBusy(false);
    }
  }, [busy, downloadUrl, remoteVersion]);

  if (!electron) return null;

  const titleText = localVersion ? `Sloncord Moderation - ${localVersion}` : "Sloncord Moderation";

  return (
    <header className="electron-titlebar">
      <div className="electron-titlebar__drag">
        <div className="electron-titlebar__brand">
          <img
            className="electron-titlebar__logo"
            src="./app-icon.png"
            alt=""
            width={20}
            height={20}
            draggable={false}
          />
          <span className="electron-titlebar__title">{titleText}</span>
        </div>
      </div>
      <div className="electron-titlebar__controls">
        {updateAvailable ? (
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
          onClick={() => window.slonmod?.minimizeWindow?.()}
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
              void window.slonmod?.setWindowFullscreen?.(false);
              return;
            }
            void window.slonmod?.maximizeWindowToggle?.();
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
          onClick={() => window.slonmod?.closeWindow?.()}
        >
          <svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true">
            <path stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" d="M3 3l6 6M9 3L3 9" />
          </svg>
        </button>
      </div>
    </header>
  );
}
