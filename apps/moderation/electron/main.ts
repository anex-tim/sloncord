import { app, BrowserWindow, ipcMain, Menu, protocol, session, shell } from "electron";
import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import fs from "node:fs";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { Readable, Transform } from "node:stream";
import Store from "electron-store";

declare const __dirname: string;
declare const SLONMOD_EMBEDDED_API_BASE: string;

protocol.registerSchemesAsPrivileged([
  {
    scheme: "slonmod",
    privileges: {
      secure: true,
      standard: true,
      supportFetchAPI: true,
      corsEnabled: true,
      stream: true,
    },
  },
]);

type ModPrefs = { apiBase: string };

function normalizeDefaultApiBase(raw: string | undefined): string {
  if (!raw?.trim()) return "";
  try {
    const u = new URL(raw.includes("://") ? raw.trim() : `https://${raw.trim()}`);
    if (u.protocol !== "http:" && u.protocol !== "https:") return "";
    return u.origin;
  } catch {
    return "";
  }
}

const store = new Store<ModPrefs>({
  name: "sloncord-moderation",
  defaults: {
    apiBase:
      normalizeDefaultApiBase(process.env.SLONMOD_DEFAULT_API_BASE) ||
      normalizeDefaultApiBase(SLONMOD_EMBEDDED_API_BASE),
  },
});

function seedApiBaseIfEmpty(): void {
  const cur = String(store.get("apiBase") ?? "").trim();
  if (cur) return;
  const next =
    normalizeDefaultApiBase(process.env.SLONMOD_DEFAULT_API_BASE) ||
    normalizeDefaultApiBase(SLONMOD_EMBEDDED_API_BASE);
  if (next) store.set("apiBase", next);
}

seedApiBaseIfEmpty();

const SLONMOD_CLIENT_ID = "SloncordModeration/1";

function resolveModApiBase(): string {
  return (
    normalizeDefaultApiBase(String(store.get("apiBase") ?? "")) ||
    normalizeDefaultApiBase(process.env.SLONMOD_DEFAULT_API_BASE) ||
    normalizeDefaultApiBase(SLONMOD_EMBEDDED_API_BASE)
  );
}

function installModApiCertificateTrust(): void {
  const api = resolveModApiBase();
  if (!api) return;
  let host = "";
  try {
    host = new URL(api).hostname;
  } catch {
    return;
  }
  session.defaultSession.setCertificateVerifyProc((request, callback) => {
    if (request.hostname === host) {
      callback(0);
      return;
    }
    callback(-2);
  });
}

function installModClientRequestHeaders(): void {
  const api = resolveModApiBase();
  if (!api) return;
  const prefix = `${api.replace(/\/$/, "")}/*`;
  session.defaultSession.webRequest.onBeforeSendHeaders({ urls: [prefix] }, (details, callback) => {
    callback({
      requestHeaders: { ...details.requestHeaders, "X-Sloncord-Client": SLONMOD_CLIENT_ID },
    });
  });
}

ipcMain.on("slonmod:get-api-base", (event) => {
  event.returnValue = String(store.get("apiBase") ?? "").trim();
});

ipcMain.on("slonmod:set-api-base", (_event, url: string) => {
  store.set("apiBase", String(url ?? "").trim());
});

function assertSafeInstallerUrl(raw: string): URL {
  const api = String(store.get("apiBase") ?? "").trim();
  if (!api) throw new Error("Не задан адрес сервера (API).");

  const u = new URL(raw.trim());
  if (u.protocol !== "https:" && u.protocol !== "http:") throw new Error("Недопустимый протокол URL установщика.");

  let apiOrigin: URL;
  try {
    apiOrigin = new URL(api.includes("://") ? api : `https://${api}`);
  } catch {
    throw new Error("Неверный сохранённый адрес API.");
  }

  if (u.hostname !== apiOrigin.hostname) throw new Error("Установщик должен быть с того же хоста, что и ваш сервер.");
  if (!u.pathname.toLowerCase().endsWith(".exe")) throw new Error("Ожидался файл .exe.");

  return u;
}

function parseUpdateVersionFromUrl(u: URL): string {
  try {
    const qp = String(u.searchParams.get("version") || u.searchParams.get("v") || "").trim();
    if (/^\d+\.\d+\.\d+/.test(qp)) return qp.match(/^\d+\.\d+\.\d+(?:[-+][\w.-]+)?/)?.[0] || qp;
  } catch {
    /* ignore */
  }
  const base = path.basename(u.pathname || "");
  const m = base.match(/(\d+\.\d+\.\d+(?:[-+][\w.-]+)?)/);
  if (m?.[1]) return String(m[1]);
  return "";
}

function getDistUiRoot(): string {
  if (app.isPackaged) return path.join(process.resourcesPath, "dist-ui");
  return path.join(__dirname, "..", "dist-ui");
}

function registerSlonmodProtocol(): void {
  const distRoot = path.normalize(getDistUiRoot());
  protocol.registerFileProtocol("slonmod", (request, callback) => {
    try {
      const u = new URL(request.url);
      let pathname = u.pathname || "/";
      if (pathname === "/") pathname = "/index.html";
      const relative = pathname.replace(/^\/+/, "") || "index.html";
      const resolvedRoot = path.resolve(distRoot);
      const resolvedFile = path.resolve(path.join(distRoot, relative));
      const rel = path.relative(resolvedRoot, resolvedFile);
      if (rel.startsWith("..") || path.isAbsolute(rel)) {
        callback({ error: -6 });
        return;
      }
      callback({ path: resolvedFile });
    } catch {
      callback({ error: -2 });
    }
  });
}

function getAppIconPath(): string {
  if (app.isPackaged) return path.join(process.resourcesPath, "app-icon.png");
  return path.join(__dirname, "..", "resources", "app-icon.png");
}

type UpdateProgressPayload =
  | { phase: "preparing" }
  | {
      phase: "downloading";
      loaded: number;
      total: number | null;
      percent: number | null;
      bps?: number | null;
      etaSeconds?: number | null;
    }
  | { phase: "installing" }
  | { phase: "prompt_install" }
  | { phase: "done" }
  | { phase: "error"; message: string };

let mainWindow: BrowserWindow | null = null;

function sendWindowStateToRenderer(): void {
  try {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    mainWindow.webContents.send("slonmod:window-state", {
      maximized: mainWindow.isMaximized(),
      fullscreen: mainWindow.isFullScreen(),
    });
  } catch {
    /* ignore */
  }
}

function getWindowTitle(): string {
  const v = String(app.getVersion() || "").trim();
  return v ? `Sloncord Moderation - ${v}` : "Sloncord Moderation";
}

function createWindow(): void {
  const iconPath = getAppIconPath();
  const win = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 900,
    minHeight: 600,
    title: getWindowTitle(),
    frame: false,
    icon: fs.existsSync(iconPath) ? iconPath : undefined,
    backgroundColor: "#1e1f22",
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  mainWindow = win;
  win.on("closed", () => {
    if (mainWindow === win) mainWindow = null;
  });
  win.setMenuBarVisibility(false);
  win.on("page-title-updated", (event) => {
    event.preventDefault();
    win.setTitle(getWindowTitle());
  });
  win.on("maximize", sendWindowStateToRenderer);
  win.on("unmaximize", sendWindowStateToRenderer);
  win.on("enter-full-screen", sendWindowStateToRenderer);
  win.on("leave-full-screen", sendWindowStateToRenderer);
  win.on("show", sendWindowStateToRenderer);

  const useVite = process.env.SLONMOD_USE_VITE === "1";
  const viteUrl = process.env.SLONMOD_VITE_URL || "http://localhost:5174";

  if (useVite) {
    void win.loadURL(viteUrl);
    win.webContents.openDevTools({ mode: "detach" });
    return;
  }

  void win.loadURL("slonmod:///index.html");
}

ipcMain.handle("slonmod:get-app-version", () => app.getVersion());

ipcMain.on("slonmod:window-minimize", () => {
  mainWindow?.minimize();
});

ipcMain.on("slonmod:window-maximize-toggle", () => {
  if (!mainWindow) return;
  if (mainWindow.isMaximized()) mainWindow.unmaximize();
  else mainWindow.maximize();
});

ipcMain.on("slonmod:window-close", () => {
  mainWindow?.close();
});

ipcMain.handle("slonmod:get-window-state", () => {
  try {
    if (!mainWindow || mainWindow.isDestroyed()) return { maximized: false, fullscreen: false };
    return { maximized: mainWindow.isMaximized(), fullscreen: mainWindow.isFullScreen() };
  } catch {
    return { maximized: false, fullscreen: false };
  }
});

ipcMain.handle("slonmod:set-window-fullscreen", (_event, flag: boolean): { ok: boolean } => {
  try {
    const w = BrowserWindow.getFocusedWindow() ?? mainWindow;
    if (!w || w.isDestroyed()) return { ok: false };
    w.setFullScreen(!!flag);
    return { ok: true };
  } catch {
    return { ok: false };
  }
});

ipcMain.handle(
  "slonmod:install-update",
  async (event, installerUrl: string): Promise<{ ok: boolean; error?: string }> => {
    const sendProgress = (data: UpdateProgressPayload): void => {
      try {
        event.sender.send("slonmod:update-progress", data);
      } catch {
        /* ignore */
      }
    };

    try {
      sendProgress({ phase: "preparing" });
      const u = assertSafeInstallerUrl(String(installerUrl ?? ""));
      const parsedVer = parseUpdateVersionFromUrl(u);
      const safeVer = String(parsedVer || app.getVersion() || "unknown")
        .trim()
        .replace(/[^\w.-]+/g, "-")
        .slice(0, 64) || "unknown";
      const dest = path.join(app.getPath("temp"), `Sloncord-Moderation-update-${safeVer}.exe`);

      const res = await fetch(u.href);
      if (!res.ok) throw new Error(`Скачивание: HTTP ${res.status}`);

      const contentLen = res.headers.get("content-length");
      const totalNum = contentLen ? parseInt(contentLen, 10) : Number.NaN;
      const hasTotal = Number.isFinite(totalNum) && totalNum > 0;
      const body = res.body;
      if (!body) throw new Error("Пустой ответ сервера");

      sendProgress({
        phase: "downloading",
        loaded: 0,
        total: hasTotal ? totalNum : null,
        percent: hasTotal ? 0 : null,
        bps: null,
        etaSeconds: null,
      });

      const PROGRESS_MS = 220;
      const PROGRESS_BYTES = 768 * 1024;
      let downloaded = 0;
      let lastSentLoaded = 0;
      let lastSentAt = 0;
      const startedAt = Date.now();

      const progressTransform = new Transform({
        transform(chunk: Buffer, _enc, callback): void {
          downloaded += chunk.length;
          const now = Date.now();
          if (
            downloaded - lastSentLoaded >= PROGRESS_BYTES ||
            now - lastSentAt >= PROGRESS_MS ||
            (hasTotal && downloaded >= totalNum)
          ) {
            lastSentLoaded = downloaded;
            lastSentAt = now;
            const pct = hasTotal ? Math.min(100, (downloaded / totalNum) * 100) : null;
            const elapsedMs = Math.max(1, now - startedAt);
            const bps = Math.max(0, Math.floor((downloaded / elapsedMs) * 1000));
            const etaSeconds =
              hasTotal && bps > 0 ? Math.max(0, Math.ceil((totalNum - downloaded) / bps)) : null;
            sendProgress({
              phase: "downloading",
              loaded: downloaded,
              total: hasTotal ? totalNum : null,
              percent: pct,
              bps,
              etaSeconds,
            });
          }
          callback(null, chunk);
        },
      });

      const webStream = body as import("stream/web").ReadableStream<Uint8Array>;
      const nodeReadable = Readable.fromWeb(webStream, { highWaterMark: 4 * 1024 * 1024 });
      const writeStream = createWriteStream(dest, { highWaterMark: 4 * 1024 * 1024 });
      await pipeline(nodeReadable, progressTransform, writeStream);

      sendProgress({
        phase: "downloading",
        loaded: downloaded,
        total: hasTotal ? totalNum : downloaded,
        percent: hasTotal ? 100 : null,
        bps: null,
        etaSeconds: null,
      });

      if (!app.isPackaged) {
        sendProgress({ phase: "prompt_install" });
        const openErr = await shell.openPath(dest);
        if (openErr) throw new Error(openErr);
        sendProgress({ phase: "done" });
        return { ok: true };
      }

      if (process.platform !== "win32") {
        sendProgress({ phase: "prompt_install" });
        const openErr = await shell.openPath(dest);
        if (openErr) throw new Error(openErr);
        sendProgress({ phase: "done" });
        return { ok: true };
      }

      sendProgress({ phase: "installing" });

      const child = spawn(dest, ["/S", "--force-run", "--updated", "--no-desktop-shortcut"], {
        detached: true,
        stdio: "ignore",
        windowsVerbatimArguments: true,
      });
      child.on("error", (err) => {
        void shell.openPath(dest).then((openErr) => {
          if (!openErr) {
            sendProgress({ phase: "prompt_install" });
          } else {
            sendProgress({
              phase: "error",
              message: err instanceof Error ? err.message : String(err),
            });
          }
        });
      });
      child.on("spawn", () => {
        setImmediate(() => {
          try {
            app.exit(0);
          } catch {
            /* ignore */
          }
        });
      });
      child.unref();
      return { ok: true };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      sendProgress({ phase: "error", message: msg });
      return { ok: false, error: msg };
    }
  }
);

app.whenReady().then(() => {
  installModApiCertificateTrust();
  installModClientRequestHeaders();
  Menu.setApplicationMenu(null);
  registerSlonmodProtocol();
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
