import { BrowserWindow, Notification, app, ipcMain, nativeImage } from "electron";
import fs from "node:fs";
import path from "node:path";

/** @param {string} s */
function escapeXmlText(s: string): string {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

let lastCallNotification: Notification | null = null;

/**
 * Путь к PNG-иконке (тот же стиль, что favicon / сайт) — в dev и в установленной сборке.
 */
export function getAppIconPath(): string | undefined {
  const dev = path.join(__dirname, "..", "resources", "app-icon.png");
  const prod = path.join(process.resourcesPath, "app-icon.png");
  const p = app.isPackaged ? prod : dev;
  if (fs.existsSync(p)) return p;
  if (!app.isPackaged && fs.existsSync(prod)) return prod;
  return undefined;
}

function iconForNotification(): string | (Electron.NativeImage) | undefined {
  const p = getAppIconPath();
  if (!p) return undefined;
  try {
    return nativeImage.createFromPath(p);
  } catch {
    return p;
  }
}

function fileUriForToast(iconPath: string): string {
  const abs = path.resolve(iconPath);
  return `file:///${abs.replace(/\\/g, "/")}`;
}

/**
 * @param {string} rawUrl
 */
export function parseInviteCodeFromWebUrl(rawUrl: string): string {
  try {
    const u = new URL(String(rawUrl).trim());
    const q = String(u.searchParams.get("invite") || "").trim();
    if (q) return q;
    const m = u.pathname.match(/\/invite\/([^/?#]+)/i);
    if (m?.[1]) return decodeURIComponent(m[1]).trim();
  } catch {
    /* ignore */
  }
  return "";
}

/**
 * @param {string} rawUrl
 * @param {() => BrowserWindow | null} getWindow
 */
export function dispatchCallActionFromProtocol(
  rawUrl: string,
  getWindow: () => BrowserWindow | null
): void {
  try {
    const u = new URL(String(rawUrl).trim());
    if (u.protocol !== "sloncord-app:") return;
    // Invite deep-link: sloncord-app://invite/?code=XXXX
    try {
      const isInvite = String(u.hostname || "").toLowerCase() === "invite";
      const code = String(u.searchParams.get("code") || u.searchParams.get("invite") || "").trim();
      if (isInvite && code) {
        const win = getWindow();
        if (win) {
          try { if (win.isMinimized()) win.restore(); } catch { /* ignore */ }
          win.show();
          win.focus();
        }
        win?.webContents?.send("sloncord:open-invite", { inviteCode: code });
        return;
      }
    } catch {
      /* ignore */
    }
    const callId = u.searchParams.get("callId") || "";
    const action = u.searchParams.get("action") || "";
    const channelId = u.searchParams.get("channelId") || "";
    const fromUserId = u.searchParams.get("fromUserId") || "";
    if (!callId || (action !== "accept" && action !== "decline")) return;
    const win = getWindow();
    if (win) {
      try {
        if (win.isMinimized()) win.restore();
      } catch {
        /* ignore */
      }
      win.show();
      win.focus();
    }
    win?.webContents?.send("sloncord:call-notif-action", {
      callId,
      channelId,
      fromUserId,
      action,
    });
  } catch {
    /* ignore */
  }
}

/**
 * @param {() => BrowserWindow | null} getWindow
 */
export function registerNotificationIpc(
  getWindow: () => BrowserWindow | null
): void {
  ipcMain.handle("sloncord:is-main-window-focused", () => {
    const w = getWindow();
    if (!w || w.isDestroyed()) return false;
    return w.isFocused() && w.isVisible();
  });

  ipcMain.handle(
    "sloncord:notify-message",
    (_e: unknown, o: { title: string; body: string }) => {
      if (!Notification.isSupported()) return { ok: false };
      const title = String(o?.title ?? "Sloncord");
      const body = String(o?.body ?? "");

      /**
       * Простой Notification({ title, body }) на Win32 часто попадает только в центр уведомлений без баннера.
       * ToastGeneric + hint-priority + duration даёт привычное всплывающее окно (как у входящего звонка).
       * Звук только из renderer (Web Audio); без ms-winsoundevent — иначе дублируется системный звук Windows.
       */
      if (process.platform === "win32") {
        const iconP = getAppIconPath();
        const img = iconP
          ? `<image placement="appLogoOverride" hint-crop="circle" src="${escapeXmlText(fileUriForToast(iconP))}"/>`
          : "";
        const xml = `
<toast activationType="foreground" duration="long" hint-priority="10">
  <visual>
    <binding template="ToastGeneric">
      <text>${escapeXmlText(title)}</text>
      <text>${escapeXmlText(body)}</text>
      ${img}
    </binding>
  </visual>
  <audio silent="true" />
</toast>`;
        const n = new Notification({ toastXml: xml } as Electron.NotificationConstructorOptions);
        n.on("click", () => {
          const w = getWindow();
          if (w) {
            if (w.isMinimized()) w.restore();
            w.show();
            w.focus();
          }
        });
        n.on("failed", (_ev, err) => {
          // eslint-disable-next-line no-console
          console.warn("Notification failed:", err);
        });
        n.show();
        try {
          setTimeout(() => {
            try { n.close(); } catch { /* ignore */ }
          }, 4000);
        } catch {
          /* ignore */
        }
        return { ok: true };
      }

      const icon = iconForNotification();
      const n = new Notification({
        title,
        body,
        silent: true,
        timeoutType: "default",
        ...(icon ? { icon: icon as Electron.NativeImage } : {}),
      });
      n.on("click", () => {
        const w = getWindow();
        if (w) {
          if (w.isMinimized()) w.restore();
          w.show();
          w.focus();
        }
      });
      n.on("failed", (_ev, err) => {
        // eslint-disable-next-line no-console
        console.warn("Notification failed:", err);
      });
      n.show();
      try {
        setTimeout(() => {
          try { n.close(); } catch { /* ignore */ }
        }, 4000);
      } catch {
        /* ignore */
      }
      return { ok: true };
    }
  );

  ipcMain.handle(
    "sloncord:notify-incoming-call",
    (
      _e: unknown,
      p: { callId: string; channelId: string; fromUserId: string; fromNickname: string }
    ) => {
      try {
        if (lastCallNotification) {
          try {
            lastCallNotification.close();
          } catch {
            /* ignore */
          }
        }
        const callId = String(p?.callId ?? "");
        const channelId = String(p?.channelId ?? "");
        const fromUserId = String(p?.fromUserId ?? "");
        const fromNickname = String(p?.fromNickname ?? "Пользователь");
        if (!callId || !channelId || !fromUserId) return { ok: false };

        const q = new URLSearchParams({
          callId,
          action: "accept",
          channelId,
          fromUserId,
        });
        const q2 = new URLSearchParams({
          callId,
          action: "decline",
          channelId,
          fromUserId,
        });
        const acceptArg = `sloncord-app://call/?${q.toString()}`;
        const declineArg = `sloncord-app://call/?${q2.toString()}`;

        const title = "Входящий звонок";
        const body = `От ${fromNickname}`;

        if (process.platform === "win32") {
          const iconP = getAppIconPath();
          const img = iconP
            ? `<image placement="appLogoOverride" hint-crop="circle" src="${escapeXmlText(
                fileUriForToast(iconP)
              )}"/>`
            : "";
          const xml = `
<toast launch="${escapeXmlText(acceptArg)}" activationType="protocol">
  <visual>
    <binding template="ToastGeneric">
      <text>${escapeXmlText(title)}</text>
      <text>${escapeXmlText(body)}</text>
      ${img}
    </binding>
  </visual>
  <actions>
    <action content="Принять" arguments="${escapeXmlText(acceptArg)}" activationType="protocol"/>
    <action content="Отклонить" arguments="${escapeXmlText(declineArg)}" activationType="protocol"/>
  </actions>
  <audio silent="true" />
</toast>`;
          const n = new Notification({ toastXml: xml } as Electron.NotificationConstructorOptions);
          n.on("click", () => {
            dispatchCallActionFromProtocol(acceptArg, getWindow);
          });
          n.on("failed", (_e2, err) => {
            // eslint-disable-next-line no-console
            console.warn("Call toast failed:", err);
          });
          lastCallNotification = n;
          n.show();
          return { ok: true };
        }

        const n = new Notification({
          title,
          body,
          silent: true,
          icon: iconForNotification() as Electron.NativeImage,
          actions: [
            { type: "button", text: "Принять" },
            { type: "button", text: "Отклонить" },
          ],
        } as Electron.NotificationConstructorOptions);
        n.on("action", (_e2, index) => {
          const action = index === 0 ? "accept" : "decline";
          getWindow()?.webContents?.send("sloncord:call-notif-action", {
            callId,
            channelId,
            fromUserId,
            action,
          });
        });
        n.on("click", () => {
          getWindow()?.webContents?.send("sloncord:call-notif-action", {
            callId,
            channelId,
            fromUserId,
            action: "accept",
          });
        });
        n.on("failed", (_e2, err) => {
          // eslint-disable-next-line no-console
          console.warn("Call notification failed:", err);
        });
        lastCallNotification = n;
        n.show();
        return { ok: true };
      } catch (e) {
        // eslint-disable-next-line no-console
        console.warn("notify-incoming-call", e);
        return { ok: false };
      }
    }
  );
}
