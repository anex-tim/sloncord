import { useCallback, useEffect, useState } from "react";
import { getApiBase } from "./api";

type ReleaseMeta = {
  version?: string;
  downloadUrl?: string;
};

const FIRST_POLL_DELAY_MS = 900;

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

    async function poll(): Promise<void> {
      const baseRaw = getApiBase().trim();
      if (!baseRaw || cancelled) return;
      try {
        const origin = `${baseRaw.replace(/\/$/, "")}/`;
        const url = new URL("/downloads/moderation-release.json", origin);
        url.searchParams.set("_", String(Date.now()));
        const res = await fetch(url.href, { cache: "no-store" });
        if (!res.ok || cancelled) return;
        const data = (await res.json()) as ReleaseMeta;
        const rv = String(data?.version ?? "").trim();
        const du = String(data?.downloadUrl ?? "").trim();
        if (!rv) return;
        setRemoteVersion(rv);
        setDownloadUrl(du ? (du.startsWith("http") ? du : new URL(du, origin).href) : null);
      } catch {
        /* offline */
      }
    }

    const t0 = window.setTimeout(() => void poll(), FIRST_POLL_DELAY_MS);
    const onVisible = (): void => {
      if (document.visibilityState === "visible") void poll();
    };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", onVisible);
    return () => {
      cancelled = true;
      clearTimeout(t0);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", onVisible);
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
