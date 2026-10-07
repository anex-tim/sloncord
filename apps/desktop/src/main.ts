import {
  app,
  BrowserWindow,
  clipboard,
  globalShortcut,
  ipcMain,
  Menu,
  nativeImage,
  net,
  protocol,
  session,
  shell,
  Tray,
} from "electron";
import { execFileSync, spawn } from "node:child_process";
import fs, { createWriteStream } from "node:fs";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { Readable, Transform } from "node:stream";
import { pathToFileURL } from "node:url";
import Store from "electron-store";
import {
  openDisplayMediaPickerWindow,
  registerDisplayPickerIpc,
  setDisplayCaptureLive,
  takeDisplaySelectionNow,
} from "./displayPicker";
import {
  dispatchCallActionFromProtocol,
  getAppIconPath,
  parseInviteCodeFromWebUrl,
  registerNotificationIpc,
} from "./notificationsMain";

/** Иконка окна: на Windows предпочитаем .ico (задачаbar / Alt+Tab), иначе PNG из getAppIconPath(). */
function getWindowIcon(): Electron.NativeImage | string | undefined {
  try {
    if (process.platform === "win32") {
      const icoDev = path.join(__dirname, "..", "resources", "app-icon.ico");
      const icoProd = path.join(process.resourcesPath, "app-icon.ico");
      const icoPath = app.isPackaged ? icoProd : icoDev;
      if (fs.existsSync(icoPath)) {
        const img = nativeImage.createFromPath(icoPath);
        if (!img.isEmpty()) return img;
      }
    }
    const pngPath = getAppIconPath();
    if (!pngPath || !fs.existsSync(pngPath)) return undefined;
    const img = nativeImage.createFromPath(pngPath);
    return img.isEmpty() ? pngPath : img;
  } catch {
    const fallback = getAppIconPath();
    return fallback || undefined;
  }
}

/** Chromium: ускоренный декод MP4/H.264; на Windows — опционально HEVC через системный кодек (Win11). До app.whenReady(). */
function configureChromiumMediaForSloncord(): void {
  try {
    app.commandLine.appendSwitch("enable-accelerated-video-decode");
    if (process.platform === "win32") {
      app.commandLine.appendSwitch("enable-features", "PlatformHEVCDecoderSupport");
    }
  } catch {
    /* ignore */
  }
}

configureChromiumMediaForSloncord();

/** Должен быть до ready: иначе getDisplayMedia на file:// даёт NotSupportedError. */
protocol.registerSchemesAsPrivileged([
  {
    scheme: "sloncord",
    privileges: {
      secure: true,
      standard: true,
      supportFetchAPI: true,
      corsEnabled: true,
      stream: true,
    },
  },
]);

/** Задаётся esbuild при сборке main.cjs (CommonJS), путь к каталогу dist-electron. */
declare const __dirname: string;

/** Подставляется в main.cjs через esbuild `define` (IP сервера, без домена). */
declare const SLONCORD_EMBEDDED_API_BASE: string;

const SLONCORD_DESKTOP_CLIENT_ID = "SloncordDesktop/1";

function isTrustedUpdateHost(hostname: string): boolean {
  const h = String(hostname || "").toLowerCase();
  if (!h) return false;
  if (h === "github.com" || h.endsWith(".github.com")) return true;
  if (h === "githubusercontent.com" || h.endsWith(".githubusercontent.com")) return true;
  return false;
}

function resolveConfiguredApiBase(): string {
  return (
    normalizeDefaultApiBase(String(store.get("apiBase") ?? "")) ||
    normalizeDefaultApiBase(process.env.SLONCORD_DEFAULT_API_BASE) ||
    normalizeDefaultApiBase(SLONCORD_EMBEDDED_API_BASE)
  );
}

/** Self-signed TLS на IP: доверяем только хосту из apiBase. */
function installApiCertificateTrust(): void {
  const api = resolveConfiguredApiBase();
  if (!api) return;
  let host = "";
  try {
    host = new URL(api).hostname;
  } catch {
    return;
  }
  if (!host) return;
  session.defaultSession.setCertificateVerifyProc((request, callback) => {
    const h = request.hostname;
    if (h === host || isTrustedUpdateHost(h)) {
      callback(0);
      return;
    }
    callback(-3);
  });
}

function installDesktopClientRequestHeaders(): void {
  const api = resolveConfiguredApiBase();
  if (!api) return;
  const prefix = `${api.replace(/\/$/, "")}/*`;
  session.defaultSession.webRequest.onBeforeSendHeaders({ urls: [prefix] }, (details, callback) => {
    const headers = { ...details.requestHeaders, "X-Sloncord-Client": SLONCORD_DESKTOP_CLIENT_ID };
    callback({ requestHeaders: headers });
  });
}

/** Удалённый API при первом запуске: задайте SLONCORD_DEFAULT_API_BASE (например https://sloncord.example.com). */
function normalizeDefaultApiBase(raw: string | undefined): string {
  if (!raw?.trim()) return "";
  try {
    const u = new URL(raw.includes("://") ? raw.trim() : `https://${raw.trim()}`);
    if (u.protocol !== "http:" && u.protocol !== "https:") return "";
    const pathClean = u.pathname.replace(/\/$/, "") || "";
    return u.origin + pathClean;
  } catch {
    return "";
  }
}

type DesktopPrefs = {
  apiBase: string;
  /** Electron accelerator string or empty = disabled */
  hotkeyToggleMic: string;
  hotkeyToggleDeafen: string;
  loginOpenAtLogin: boolean;
  loginStartHidden: boolean;
};

const store = new Store<DesktopPrefs>({
  name: "sloncord-desktop",
  defaults: {
    apiBase:
      normalizeDefaultApiBase(process.env.SLONCORD_DEFAULT_API_BASE) ||
      normalizeDefaultApiBase(SLONCORD_EMBEDDED_API_BASE),
    hotkeyToggleMic: "",
    hotkeyToggleDeafen: "",
    loginOpenAtLogin: false,
    loginStartHidden: false,
  },
});

/** Старый домен отключён на VPS — переводим сохранённый apiBase на вшитый IP. */
function migrateLegacyDomainApiBase(): void {
  const cur = String(store.get("apiBase") ?? "").trim();
  if (!cur) return;
  let host = "";
  try {
    host = new URL(cur).hostname.toLowerCase();
  } catch {
    return;
  }
  const legacy =
    host === "sloncord.ru" ||
    host === "www.sloncord.ru" ||
    host.endsWith(".sloncord.ru");
  if (!legacy) return;
  const next =
    normalizeDefaultApiBase(SLONCORD_EMBEDDED_API_BASE) ||
    normalizeDefaultApiBase(process.env.SLONCORD_DEFAULT_API_BASE);
  if (next) store.set("apiBase", next);
}

/** Если раньше в store записали пустую строку — подставляем вшитый URL. */
function seedApiBaseIfEmpty(): void {
  const cur = String(store.get("apiBase") ?? "").trim();
  if (cur) return;
  const fromEnv = normalizeDefaultApiBase(process.env.SLONCORD_DEFAULT_API_BASE);
  const fromEmb = normalizeDefaultApiBase(SLONCORD_EMBEDDED_API_BASE);
  const next = fromEnv || fromEmb;
  if (next) store.set("apiBase", next);
}

migrateLegacyDomainApiBase();
seedApiBaseIfEmpty();

ipcMain.on("sloncord:get-api-base", (event) => {
  event.returnValue = String(store.get("apiBase") ?? "").trim();
});

ipcMain.on("sloncord:set-api-base", (_event, url: string) => {
  store.set("apiBase", String(url ?? "").trim());
});

const SLONCORD_ARG_START_MINIMIZED = "--sloncord-start-minimized";
const argvRequestsStartMinimized = process.argv.includes(SLONCORD_ARG_START_MINIMIZED);

let lastRegisteredVoiceHotkeys: string[] = [];

function unregisterTrackedVoiceHotkeys(): void {
  for (const acc of lastRegisteredVoiceHotkeys) {
    try {
      globalShortcut.unregister(acc);
    } catch {
      /* ignore */
    }
  }
  lastRegisteredVoiceHotkeys = [];
}

function applyVoiceHotkeysFromStore(): void {
  unregisterTrackedVoiceHotkeys();
  const mic = String(store.get("hotkeyToggleMic") ?? "").trim();
  const deaf = String(store.get("hotkeyToggleDeafen") ?? "").trim();

  const reg = (accelerator: string, channel: string): void => {
    if (!accelerator) return;
    try {
      const ok = globalShortcut.register(accelerator, () => {
        try {
          if (!mainWindow || mainWindow.isDestroyed()) return;
          mainWindow.webContents.send(channel);
        } catch {
          /* ignore */
        }
      });
      if (ok) lastRegisteredVoiceHotkeys.push(accelerator);
    } catch {
      /* ignore */
    }
  };

  if (mic) reg(mic, "sloncord:hotkey-toggle-mic");
  if (deaf && deaf !== mic) reg(deaf, "sloncord:hotkey-toggle-deafen");
}

function applyLoginItemFromStore(): void {
  try {
    const open = !!store.get("loginOpenAtLogin");
    const hidden = !!store.get("loginStartHidden");
    if (!open) {
      app.setLoginItemSettings({ openAtLogin: false });
      return;
    }
    app.setLoginItemSettings({
      openAtLogin: true,
      path: process.execPath,
      args: hidden ? [SLONCORD_ARG_START_MINIMIZED] : [],
    });
  } catch {
    /* ignore */
  }
}

ipcMain.handle("sloncord:get-desktop-prefs", () => {
  return {
    hotkeyToggleMic: String(store.get("hotkeyToggleMic") ?? "").trim(),
    hotkeyToggleDeafen: String(store.get("hotkeyToggleDeafen") ?? "").trim(),
    loginOpenAtLogin: !!store.get("loginOpenAtLogin"),
    loginStartHidden: !!store.get("loginStartHidden"),
  };
});

ipcMain.handle(
  "sloncord:set-desktop-prefs",
  (
    _event,
    patch: Partial<{
      hotkeyToggleMic: string;
      hotkeyToggleDeafen: string;
      loginOpenAtLogin: boolean;
      loginStartHidden: boolean;
    }>
  ): { ok: boolean } => {
    try {
      if (patch && typeof patch === "object") {
        if (typeof patch.hotkeyToggleMic === "string") store.set("hotkeyToggleMic", patch.hotkeyToggleMic.trim());
        if (typeof patch.hotkeyToggleDeafen === "string") store.set("hotkeyToggleDeafen", patch.hotkeyToggleDeafen.trim());
        if (typeof patch.loginOpenAtLogin === "boolean") store.set("loginOpenAtLogin", patch.loginOpenAtLogin);
        if (typeof patch.loginStartHidden === "boolean") store.set("loginStartHidden", patch.loginStartHidden);
      }
      applyLoginItemFromStore();
      applyVoiceHotkeysFromStore();
      return { ok: true };
    } catch {
      return { ok: false };
    }
  }
);

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let isQuitting = false;
let pendingTaskbarBadge = 0;

/** 3×5 pixel glyphs for overlay digits (Discord-style taskbar badge). */
const OVERLAY_DIGIT_GLYPHS: Record<string, number[]> = {
  "0": [0b111, 0b101, 0b101, 0b101, 0b111],
  "1": [0b010, 0b110, 0b010, 0b010, 0b111],
  "2": [0b111, 0b001, 0b111, 0b100, 0b111],
  "3": [0b111, 0b001, 0b111, 0b001, 0b111],
  "4": [0b101, 0b101, 0b111, 0b001, 0b001],
  "5": [0b111, 0b100, 0b111, 0b001, 0b111],
  "6": [0b111, 0b100, 0b111, 0b101, 0b111],
  "7": [0b111, 0b001, 0b001, 0b001, 0b001],
  "8": [0b111, 0b101, 0b111, 0b101, 0b111],
  "9": [0b111, 0b101, 0b111, 0b001, 0b111],
  "+": [0b000, 0b010, 0b111, 0b010, 0b000],
};

function overlaySetPixel(buf: Buffer, size: number, x: number, y: number, r: number, g: number, b: number, a = 255): void {
  if (x < 0 || y < 0 || x >= size || y >= size) return;
  const i = (y * size + x) * 4;
  // Electron raw bitmap on Windows expects BGRA byte order.
  buf[i] = b;
  buf[i + 1] = g;
  buf[i + 2] = r;
  buf[i + 3] = a;
}

function overlayFillCircle(buf: Buffer, size: number, cx: number, cy: number, radius: number): void {
  const r = 237;
  const g = 66;
  const b = 69;
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const dx = x + 0.5 - cx;
      const dy = y + 0.5 - cy;
      if (dx * dx + dy * dy <= radius * radius) {
        overlaySetPixel(buf, size, x, y, r, g, b, 255);
      }
    }
  }
}

function overlayDrawGlyph(buf: Buffer, size: number, glyph: number[], ox: number, oy: number, scale: number): void {
  for (let row = 0; row < glyph.length; row += 1) {
    for (let col = 0; col < 3; col += 1) {
      if (((glyph[row] >> (2 - col)) & 1) === 0) continue;
      for (let sy = 0; sy < scale; sy += 1) {
        for (let sx = 0; sx < scale; sx += 1) {
          overlaySetPixel(buf, size, ox + col * scale + sx, oy + row * scale + sy, 255, 255, 255, 255);
        }
      }
    }
  }
}

function createTaskbarOverlayIcon(label: string): Electron.NativeImage | null {
  try {
    const size = 16;
    const buf = Buffer.alloc(size * size * 4, 0);
    overlayFillCircle(buf, size, 8, 8, 7.5);
    const text = label.length > 2 ? "9+" : label;
    if (text === "9+") {
      overlayDrawGlyph(buf, size, OVERLAY_DIGIT_GLYPHS["9"] || [], 1, 5, 1);
      overlayDrawGlyph(buf, size, OVERLAY_DIGIT_GLYPHS["+"] || [], 9, 5, 1);
    } else if (text.length === 1) {
      overlayDrawGlyph(buf, size, OVERLAY_DIGIT_GLYPHS[text] || [], 5, 5, 1);
    } else {
      overlayDrawGlyph(buf, size, OVERLAY_DIGIT_GLYPHS[text[0] || "0"] || [], 2, 5, 1);
      overlayDrawGlyph(buf, size, OVERLAY_DIGIT_GLYPHS[text[1] || "0"] || [], 8, 5, 1);
    }
    const img = nativeImage.createFromBuffer(buf, { width: size, height: size, scaleFactor: 1.0 });
    if (!img || img.isEmpty()) return null;
    return img;
  } catch {
    return null;
  }
}

function applyTaskbarBadge(count: number): void {
  const n = Math.max(0, Math.floor(Number(count) || 0));
  pendingTaskbarBadge = n;
  try {
    const win = mainWindow;
    if (n <= 0) {
      if (process.platform === "darwin" || process.platform === "win32" || process.platform === "linux") {
        app.setBadgeCount(0);
      }
      try { win?.setOverlayIcon?.(null, ""); } catch { /* ignore */ }
      return;
    }
    const label = n > 9 ? "9+" : String(n);
    if (process.platform === "win32") {
      try { app.setBadgeCount(0); } catch { /* ignore */ }
      if (win && !win.isDestroyed()) {
        const img = createTaskbarOverlayIcon(label);
        if (img) {
          win.setOverlayIcon(img, `${label} непрочитанных`);
          return;
        }
      }
    }
    if (process.platform === "darwin" || process.platform === "linux") {
      app.setBadgeCount(n > 9 ? 10 : n);
    }
  } catch {
    /* ignore */
  }
}

function getTrayIcon(): Electron.NativeImage | string | undefined {
  // Reuse the best-available icon: on Windows prefer ICO, otherwise PNG.
  return getWindowIcon();
}

function sendWindowStateToRenderer(): void {
  try {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    mainWindow.webContents.send("sloncord:window-state", {
      maximized: mainWindow.isMaximized(),
      fullscreen: mainWindow.isFullScreen(),
    });
  } catch {
    /* ignore */
  }
}

function ensureTray(): void {
  if (tray) return;
  try {
    const icon = getTrayIcon();
    const img = typeof icon === "string" ? nativeImage.createFromPath(icon) : icon;
    tray = new Tray(img && "isEmpty" in img && !img.isEmpty() ? img : nativeImage.createEmpty());
    tray.setToolTip("Sloncord");

    const menu = Menu.buildFromTemplate([
      {
        label: "Закрыть Sloncord",
        click: () => {
          isQuitting = true;
          try {
            if (mainWindow && !mainWindow.isDestroyed()) {
              mainWindow.destroy();
            }
          } catch {
            /* ignore */
          }
          app.quit();
        },
      },
    ]);
    tray.setContextMenu(menu);

    const toggle = (): void => {
      if (!mainWindow || mainWindow.isDestroyed()) return;
      if (mainWindow.isMinimized()) {
        mainWindow.restore();
        mainWindow.show();
        mainWindow.focus();
        return;
      }
      if (mainWindow.isVisible()) {
        mainWindow.minimize();
        return;
      }
      mainWindow.show();
      mainWindow.focus();
    };

    tray.on("click", toggle);
    tray.on("double-click", toggle);
  } catch {
    tray = null;
  }
}

ipcMain.handle(
  "sloncord:set-window-fullscreen",
  (_event, flag: boolean): { ok: boolean } => {
    try {
      const w = BrowserWindow.getFocusedWindow() ?? mainWindow;
      if (!w || w.isDestroyed()) return { ok: false };
      w.setFullScreen(!!flag);
      return { ok: true };
    } catch {
      return { ok: false };
    }
  }
);

function assertSafeInstallerUrl(raw: string): URL {
  const u = new URL(raw.trim());
  if (u.protocol !== "https:" && u.protocol !== "http:") throw new Error("Недопустимый протокол URL установщика.");

  if (isTrustedUpdateHost(u.hostname)) {
    if (!u.pathname.toLowerCase().endsWith(".exe")) throw new Error("Ожидался файл .exe.");
    return u;
  }

  const api = String(store.get("apiBase") ?? "").trim();
  if (!api) throw new Error("Не задан адрес сервера (API). Укажите его в приложении.");

  let apiOrigin: URL;
  try {
    apiOrigin = new URL(api.includes("://") ? api : `https://${api}`);
  } catch {
    throw new Error("Неверный сохранённый адрес API.");
  }

  if (u.hostname !== apiOrigin.hostname) {
    throw new Error("Установщик должен быть с GitHub Releases или с того же хоста, что и ваш сервер.");
  }

  if (!u.pathname.toLowerCase().endsWith(".exe")) throw new Error("Ожидался файл .exe.");

  return u;
}

function parseUpdateVersionFromUrl(u: URL): string {
  try {
    // Try query params first (if backend ever adds them).
    const qp =
      String(u.searchParams.get("version") || u.searchParams.get("v") || "").trim();
    if (/^\d+\.\d+\.\d+/.test(qp)) return qp.match(/^\d+\.\d+\.\d+(?:[-+][\w.-]+)?/)?.[0] || qp;
  } catch {
    /* ignore */
  }
  const base = path.basename(u.pathname || "");
  const m = base.match(/(\d+\.\d+\.\d+(?:[-+][\w.-]+)?)/);
  if (m && m[1]) return String(m[1]);
  return "";
}

async function readPackageJsonVersion(): Promise<string> {
  try {
    // Packaged: app.getAppPath() points to ".../resources/app.asar" (package.json exists inside asar).
    // Dev: app.getAppPath() points to the app folder that also has package.json.
    const p = path.join(app.getAppPath(), "package.json");
    const raw = await fs.promises.readFile(p, "utf-8");
    const j = JSON.parse(String(raw || "{}"));
    const v = String(j?.version || "").trim();
    return /^\d+\.\d+\.\d+/.test(v) ? v : "";
  } catch {
    return "";
  }
}

type UpdateProgressPayload =
  | { phase: "preparing" }
  | { phase: "downloading"; loaded: number; total: number | null; percent: number | null; bps?: number | null; etaSeconds?: number | null }
  | { phase: "installing" }
  | { phase: "prompt_install" }
  | { phase: "done" }
  | { phase: "error"; message: string };

type NativeScreenAudioStartResult =
  | {
      ok: true;
      captureMode?: "exclude-tree" | "dual-subtract" | "subtract-fallback";
      excludeRootPid?: number;
      format?: { sampleRate: number; channels: number; bitsPerSample: number; formatTag: number };
    }
  | { ok: false; error: string };

let nativeAudioHelper:
  | {
      proc: ReturnType<typeof spawn>;
      pipePath: string;
      reader: fs.ReadStream | null;
      leftover: Buffer;
      dropping: boolean;
    }
  | null = null;

function listDirectChildPids(parentPid: number): number[] {
  if (process.platform !== "win32") return [];
  try {
    const out = execFileSync(
      "powershell",
      [
        "-NoProfile",
        "-Command",
        `(Get-CimInstance Win32_Process -Filter "ParentProcessId=${parentPid}").ProcessId`,
      ],
      { encoding: "utf8", timeout: 5000 }
    );
    return String(out || "")
      .split(/\s+/)
      .map((x) => parseInt(x.trim(), 10))
      .filter((x) => Number.isFinite(x) && x > 0);
  } catch {
    return [];
  }
}

function getParentPid(pid: number): number | null {
  if (process.platform !== "win32" || !Number.isFinite(pid) || pid <= 0) return null;
  try {
    const out = execFileSync(
      "powershell",
      [
        "-NoProfile",
        "-Command",
        `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").ParentProcessId`,
      ],
      { encoding: "utf8", timeout: 5000 }
    );
    const n = parseInt(String(out || "").trim(), 10);
    return Number.isFinite(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

/** Корень дерева Sloncord для WASAPI exclude/include (обычно main, иначе общий предок renderer/GPU). */
function pickExcludeRootPid(): number {
  const slon = getSloncordProcessPids();
  const slonSet = new Set(slon);
  if (slonSet.has(process.pid)) return process.pid;

  const chains = slon.map((pid) => {
    const chain: number[] = [pid];
    let cur = pid;
    for (let i = 0; i < 32; i++) {
      const parent = getParentPid(cur);
      if (!parent || parent === cur) break;
      chain.push(parent);
      cur = parent;
    }
    return chain;
  });
  if (!chains.length) return process.pid;

  const first = chains[0];
  for (const candidate of first) {
    if (!slonSet.has(candidate) && candidate !== process.pid) continue;
    if (chains.every((ch) => ch.includes(candidate))) return candidate;
  }
  return process.pid;
}

function getExcludeRootPidCandidates(): number[] {
  const out: number[] = [];
  const seen = new Set<number>();
  const add = (pid: number | null | undefined) => {
    if (!Number.isFinite(pid) || !pid || pid <= 0 || seen.has(pid)) return;
    seen.add(pid);
    out.push(pid);
  };
  add(pickExcludeRootPid());
  add(process.pid);
  try {
    for (const m of app.getAppMetrics()) {
      if (m?.type === "Browser" || m?.type === "GPU" || m?.type === "Tab") add(m.pid);
    }
  } catch {
    /* ignore */
  }
  try {
    for (const w of BrowserWindow.getAllWindows()) add(w?.webContents?.getOSProcessId?.());
  } catch {
    /* ignore */
  }
  return out;
}

/** Все PID процессов Sloncord/Electron (для legacy subtract-fallback). */
function getSloncordProcessPids(): number[] {
  const seeds = new Set<number>();
  seeds.add(process.pid);
  try {
    for (const m of app.getAppMetrics()) {
      if (m?.pid) seeds.add(m.pid);
    }
  } catch {
    /* ignore */
  }
  try {
    for (const w of BrowserWindow.getAllWindows()) {
      try {
        const pid = w?.webContents?.getOSProcessId?.();
        if (Number.isFinite(pid) && pid > 0) seeds.add(pid);
      } catch {
        /* ignore */
      }
    }
  } catch {
    /* ignore */
  }

  const pids = new Set<number>();
  const queue = [...seeds];
  while (queue.length) {
    const pid = queue.pop()!;
    if (pids.has(pid)) continue;
    pids.add(pid);
    for (const child of listDirectChildPids(pid)) {
      if (!pids.has(child)) queue.push(child);
    }
  }
  return [...pids].filter((x) => Number.isFinite(x) && x > 0).sort((a, b) => a - b);
}

async function helperProcessFailedQuickly(proc: ReturnType<typeof spawn>, waitMs = 800): Promise<boolean> {
  return await new Promise((resolve) => {
    let done = false;
    const finish = (failed: boolean) => {
      if (done) return;
      done = true;
      try {
        clearTimeout(timer);
      } catch {
        /* ignore */
      }
      resolve(failed);
    };
    const timer = setTimeout(() => finish(false), waitMs);
    proc.once("exit", (code) => finish(code != null && code !== 0));
  });
}

function parseDesktopCapturerHwnd(sourceId: string): bigint | null {
  // Electron window sources are typically: "window:HWND:0"
  const parts = String(sourceId || "").split(":");
  if (parts.length < 2) return null;
  if (parts[0] !== "window") return null;
  const raw = parts[1] || "";
  try {
    // usually decimal, but allow hex
    if (/^0x/i.test(raw)) return BigInt(raw);
    if (/^[0-9]+$/.test(raw)) return BigInt(raw);
    if (/^[0-9a-fA-F]+$/.test(raw)) return BigInt("0x" + raw);
    return null;
  } catch {
    return null;
  }
}

async function connectNamedPipeReadStream(pipePath: string, attempts = 50): Promise<fs.ReadStream> {
  let lastErr: unknown = null;
  for (let i = 0; i < attempts; i++) {
    try {
      const rs = fs.createReadStream(pipePath);
      await new Promise<void>((resolve, reject) => {
        rs.once("open", () => resolve());
        rs.once("error", (e) => reject(e));
      });
      return rs;
    } catch (e) {
      lastErr = e;
      await new Promise((r) => setTimeout(r, 40));
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error("Не удалось подключиться к named pipe");
}

type NativeVoiceProc = {
  proc: ReturnType<typeof spawn>;
  /** Остановлен намеренно (смена канала / destroy) — не слать error в UI. */
  stopping: boolean;
  /** Сразу завершает ожидание ready, если stop пришёл до ответа helper. */
  cancelStart?: (reason: string) => void;
};

let nativeVoiceHelper: NativeVoiceProc | null = null;

function resolveNativeVoiceHelperPath(): string {
  const helperDev = path.join(__dirname, "..", "resources", "SloncordNativeVoice.exe");
  const helperProd = path.join(process.resourcesPath, "SloncordNativeVoice.exe");
  return app.isPackaged ? helperProd : helperDev;
}

function stopNativeVoiceInternal(): void {
  const cur = nativeVoiceHelper;
  nativeVoiceHelper = null;
  try {
    cur?.cancelStart?.("cancelled");
  } catch {
    /* ignore */
  }
  if (!cur?.proc) return;
  cur.stopping = true;
  try {
    cur.proc.stdout?.removeAllListeners("data");
    cur.proc.stderr?.removeAllListeners("data");
    cur.proc.removeAllListeners("exit");
  } catch {
    /* ignore */
  }
  try {
    cur.proc.stdin?.write(`${JSON.stringify({ cmd: "stop" })}\n`);
  } catch {
    /* ignore */
  }
  try {
    cur.proc.kill();
  } catch {
    /* ignore */
  }
}

ipcMain.handle(
  "sloncord:stop-native-voice",
  async (): Promise<{ ok: boolean }> => {
    stopNativeVoiceInternal();
    return { ok: true };
  }
);

ipcMain.handle(
  "sloncord:start-native-voice",
  async (
    _event,
    cfg: {
      udpHost: string;
      udpPort: number;
      sessionToken: string;
      sessionId: number;
      roomId: string;
      userId: string;
      muted?: boolean;
      deafened?: boolean;
    }
  ): Promise<{ ok: boolean; error?: string }> => {
    try {
      stopNativeVoiceInternal();
      const helperPath = resolveNativeVoiceHelperPath();
      if (!fs.existsSync(helperPath)) {
        return { ok: false, error: `Не найден SloncordNativeVoice: ${helperPath}` };
      }
      const proc = spawn(helperPath, [], { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
      const helper: NativeVoiceProc = { proc, stopping: false };
      nativeVoiceHelper = helper;
      proc.stdout?.on("data", (chunk: Buffer) => {
        if (nativeVoiceHelper?.proc !== proc) return;
        const lines = String(chunk || "").split(/\r?\n/);
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const msg = JSON.parse(line) as {
              type?: string;
              speaking?: boolean;
              level?: number;
              message?: string;
              sessionId?: number;
              jpegBase64?: string;
            };
            const win = BrowserWindow.getAllWindows()[0];
            if (!win) continue;
            if (msg.type === "speaking") {
              win.webContents.send("sloncord:native-voice-speaking", {
                speaking: !!msg.speaking,
                level: Number(msg.level) || 0,
                threshold: Number(msg.threshold) || 0.03,
              });
            } else if (msg.type === "remoteVideo" && msg.jpegBase64) {
              win.webContents.send("sloncord:native-remote-video", {
                sessionId: Number(msg.sessionId) || 0,
                jpegBase64: String(msg.jpegBase64),
              });
            } else if (msg.type === "error") {
              if (helper.stopping || nativeVoiceHelper?.proc !== proc) return;
              win.webContents.send("sloncord:native-voice-error", String(msg.message || "native_voice_error"));
            }
          } catch {
            /* ignore */
          }
        }
      });
      proc.stderr?.on("data", (chunk: Buffer) => {
        try {
          console.error("[SloncordNativeVoice]", String(chunk || ""));
        } catch {
          /* ignore */
        }
      });
      proc.on("exit", (code, signal) => {
        if (helper.stopping) return;
        if (nativeVoiceHelper?.proc === proc) nativeVoiceHelper = null;
        if (code === 0 || signal === "SIGTERM") return;
        if (nativeVoiceHelper && nativeVoiceHelper.proc !== proc) return;
        try {
          const win = BrowserWindow.getAllWindows()[0];
          win?.webContents.send(
            "sloncord:native-voice-error",
            `SloncordNativeVoice завершился (code=${code ?? "?"})`
          );
        } catch {
          /* ignore */
        }
      });
      const startLine = `${JSON.stringify({ cmd: "start", ...cfg })}\n`;
      const ready = await new Promise<{ ok: boolean; error?: string }>((resolve) => {
        let settled = false;
        const finish = (r: { ok: boolean; error?: string }) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          proc.stdout?.off("data", onData);
          resolve(r);
        };
        helper.cancelStart = (reason) => finish({ ok: false, error: reason || "cancelled" });
        proc.once("exit", () => finish({ ok: false, error: "cancelled" }));
        const timer = setTimeout(
          () => finish({ ok: false, error: "SloncordNativeVoice: нет ответа ready (таймаут 8 с)" }),
          8000
        );
        const onData = (chunk: Buffer) => {
          const lines = String(chunk || "").split(/\r?\n/);
          for (const line of lines) {
            if (!line.trim()) continue;
            try {
              const msg = JSON.parse(line) as { type?: string; message?: string };
              if (msg.type === "ready") finish({ ok: true });
              if (msg.type === "error") finish({ ok: false, error: String(msg.message || "native_voice_error") });
            } catch {
              /* ignore */
            }
          }
        };
        proc.stdout?.on("data", onData);
        try {
          proc.stdin?.write(startLine);
        } catch (e) {
          finish({ ok: false, error: e instanceof Error ? e.message : String(e) });
        }
      });
      if (!ready.ok) {
        stopNativeVoiceInternal();
        return { ok: false, error: ready.error || "native_voice_start_failed" };
      }
      return { ok: true };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return { ok: false, error: msg };
    }
  }
);

ipcMain.handle("sloncord:set-native-voice-muted", async (_e, muted: boolean) => {
  try {
    nativeVoiceHelper?.proc.stdin?.write(`${JSON.stringify({ cmd: "setMuted", muted: !!muted })}\n`);
    return { ok: true };
  } catch {
    return { ok: false };
  }
});

ipcMain.handle("sloncord:send-native-video-frame", async (_e, jpegBase64: string) => {
  try {
    const stdin = nativeVoiceHelper?.proc.stdin;
    const jpeg = String(jpegBase64 || "");
    if (!stdin?.writable || stdin.writableLength > 1_500_000 || jpeg.length > 220_000) return { ok: false };
    stdin.write(`${JSON.stringify({ cmd: "videoFrame", jpegBase64: jpeg })}\n`);
    return { ok: true };
  } catch {
    return { ok: false };
  }
});

ipcMain.handle("sloncord:set-native-voice-input-device", async (_e, deviceId: string) => {
  try {
    nativeVoiceHelper?.proc.stdin?.write(`${JSON.stringify({ cmd: "setInputDevice", deviceId: String(deviceId || "") })}\n`);
    return { ok: true };
  } catch {
    return { ok: false };
  }
});

ipcMain.handle("sloncord:set-native-voice-processing", async (_e, opts: Record<string, unknown> | null) => {
  try {
    nativeVoiceHelper?.proc.stdin?.write(`${JSON.stringify({ cmd: "setAudioProcessing", ...(opts || {}) })}\n`);
    return { ok: true };
  } catch {
    return { ok: false };
  }
});

ipcMain.handle("sloncord:set-native-voice-mic-gain", async (_e, gain: number) => {
  try {
    nativeVoiceHelper?.proc.stdin?.write(`${JSON.stringify({ cmd: "setMicGain", gain: Number(gain) || 0 })}\n`);
    return { ok: true };
  } catch {
    return { ok: false };
  }
});

ipcMain.handle("sloncord:set-native-voice-watch-screen", async (_e, sessionId: number) => {
  try {
    nativeVoiceHelper?.proc.stdin?.write(
      `${JSON.stringify({ cmd: "setWatchScreen", sessionId: Number(sessionId) || 0 })}\n`
    );
    return { ok: true };
  } catch {
    return { ok: false };
  }
});

ipcMain.handle("sloncord:play-native-screen-pcm", async (_e, pcmBase64: string, gain: number) => {
  try {
    const pcm = String(pcmBase64 || "");
    if (!pcm || pcm.length > 120_000) return { ok: false };
    nativeVoiceHelper?.proc.stdin?.write(
      `${JSON.stringify({ cmd: "playScreenPcm", pcmBase64: pcm, gain: Number(gain) || 0 })}\n`
    );
    return { ok: true };
  } catch {
    return { ok: false };
  }
});

ipcMain.handle("sloncord:set-native-voice-speaker-gain", async (_e, gain: number) => {
  try {
    nativeVoiceHelper?.proc.stdin?.write(`${JSON.stringify({ cmd: "setSpeakerGain", gain: Number(gain) || 0 })}\n`);
    return { ok: true };
  } catch {
    return { ok: false };
  }
});

ipcMain.handle("sloncord:set-native-voice-output-device", async (_e, deviceId: string) => {
  try {
    nativeVoiceHelper?.proc.stdin?.write(`${JSON.stringify({ cmd: "setOutputDevice", deviceId: String(deviceId || "") })}\n`);
    return { ok: true };
  } catch {
    return { ok: false };
  }
});

ipcMain.handle("sloncord:set-native-voice-deafened", async (_e, deafened: boolean) => {
  try {
    nativeVoiceHelper?.proc.stdin?.write(`${JSON.stringify({ cmd: "setDeafened", deafened: !!deafened })}\n`);
    return { ok: true };
  } catch {
    return { ok: false };
  }
});

function forwardScreenPcmToNativeVoice(payload: Buffer): void {
  const voice = nativeVoiceHelper;
  if (!voice?.proc?.stdin?.writable || voice.stopping) return;
  if (payload.length < 4 || payload.length > 256 * 1024) return;
  try {
    voice.proc.stdin.write(
      `${JSON.stringify({ cmd: "mixScreenPcm", pcmBase64: payload.toString("base64") })}\n`
    );
  } catch {
    /* ignore */
  }
}

function clearNativeVoiceScreenPcm(): void {
  const voice = nativeVoiceHelper;
  if (!voice?.proc?.stdin?.writable || voice.stopping) return;
  try {
    voice.proc.stdin.write(`${JSON.stringify({ cmd: "clearScreenPcm" })}\n`);
  } catch {
    /* ignore */
  }
}

function stopNativeScreenAudioInternal(): void {
  clearNativeVoiceScreenPcm();
  const cur = nativeAudioHelper;
  nativeAudioHelper = null;
  try {
    cur?.reader?.destroy();
  } catch {
    /* ignore */
  }
  try {
    cur?.proc?.kill();
  } catch {
    /* ignore */
  }
}

ipcMain.handle("sloncord:stop-native-screen-audio", async (): Promise<{ ok: boolean }> => {
  stopNativeScreenAudioInternal();
  return { ok: true };
});

ipcMain.handle("sloncord:set-display-capture-live", async (_e, live: boolean): Promise<{ ok: boolean }> => {
  setDisplayCaptureLive(!!live);
  return { ok: true };
});

ipcMain.handle(
  "sloncord:start-native-screen-audio",
  async (
    _event,
    selection?: { tab: "screen" | "window"; sourceId: string; withSystemAudio: boolean } | null
  ): Promise<NativeScreenAudioStartResult> => {
    try {
      stopNativeScreenAudioInternal();

      const sel = selection ?? takeDisplaySelectionNow();
      if (!sel) return { ok: false, error: "Не удалось получить выбор демонстрации (selection пустой)." };
      if (!sel.withSystemAudio) return { ok: false, error: "Захват звука выключен в окне выбора." };

      const helperDev = path.join(__dirname, "..", "resources", "SloncordWinAudioHelper.exe");
      const helperProd = path.join(process.resourcesPath, "SloncordWinAudioHelper.exe");
      const helperPath = app.isPackaged ? helperProd : helperDev;
      if (!fs.existsSync(helperPath)) {
        return { ok: false, error: `Не найден helper: ${helperPath}` };
      }

      async function spawnScreenAudioHelper(
        mode: "exclude-tree" | "screen-dual" | "subtract-fallback",
        excludeRootPid: number
      ) {
        const pipe = `\\\\.\\pipe\\sloncord-audio-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
        // Process-loopback EXCLUDE на этой Windows отдаёт тишину. Обычный loopback устройства
        // захватывает звук других программ.
        const args: string[] = ["--pipe", pipe, "--mode", "system"];
        void mode;
        void excludeRootPid;
        const proc = spawn(helperPath, args, { windowsHide: true, stdio: "ignore" });
        const reader = await connectNamedPipeReadStream(pipe);
        return { proc, reader, pipe };
      }

      async function tryStartScreenCapture(): Promise<{
        started: { proc: ReturnType<typeof spawn>; reader: fs.ReadStream; pipe: string };
        captureMode: "exclude-tree" | "dual-subtract" | "subtract-fallback";
        excludeRootPid: number;
      }> {
        // Только корень Electron: renderer, GPU, utility и SloncordNativeVoice — его дети.
        // Вычитание полного микса не используем: из-за рассинхрона зритель слышал сам себя.
        const excludeRootPid = process.pid;
        const started = await spawnScreenAudioHelper("exclude-tree", excludeRootPid);
        if (await helperProcessFailedQuickly(started.proc, 450)) {
          try {
            started.reader.destroy();
          } catch {
            /* ignore */
          }
          try {
            started.proc.kill();
          } catch {
            /* ignore */
          }
          throw new Error(
            "Не удалось захватить системный звук без звука Sloncord. Демонстрация продолжится без системного звука."
          );
        }
        return { started, captureMode: "exclude-tree", excludeRootPid };
      }

      let captureMode: "exclude-tree" | "dual-subtract" | "subtract-fallback" = "exclude-tree";
      let excludeRootPid = process.pid;
      let pipeLeftover = Buffer.alloc(0);
      let started: { proc: ReturnType<typeof spawn>; reader: fs.ReadStream; pipe: string };

      // И экран, и окно: системный микс без звука самого Sloncord.
      // Захват только процесса окна не отдаёт звук других программ.
      const capture = await tryStartScreenCapture();
      started = capture.started;
      captureMode = capture.captureMode;
      excludeRootPid = capture.excludeRootPid;

      nativeAudioHelper = {
        proc: started.proc,
        pipePath: started.pipe,
        reader: started.reader,
        leftover: pipeLeftover,
        dropping: false,
      };

      const MAX_INFLIGHT = 2 * 1024 * 1024;
      let inflight = 0;

      nativeAudioHelper.reader.on("data", (chunk: Buffer) => {
        const cur = nativeAudioHelper;
        if (!cur) return;
        cur.leftover = Buffer.concat([cur.leftover, chunk]);
        while (cur.leftover.length >= 4) {
          const len = cur.leftover.readUInt32LE(0);
          if (len <= 0 || len > 16 * 1024 * 1024) {
            // corrupted length -> reset buffer
            cur.leftover = Buffer.alloc(0);
            return;
          }
          if (cur.leftover.length < 4 + len) return;
          const payload = Buffer.from(cur.leftover.subarray(4, 4 + len));
          cur.leftover = cur.leftover.subarray(4 + len);
          forwardScreenPcmToNativeVoice(payload);

          if (mainWindow && !mainWindow.isDestroyed()) {
            if (inflight > MAX_INFLIGHT) {
              cur.dropping = true;
              continue;
            }
            inflight += payload.length;
            try {
              mainWindow.webContents.send("sloncord:native-screen-audio", payload);
            } catch {
              /* ignore */
            } finally {
              inflight = Math.max(0, inflight - payload.length);
            }
          }
        }
      });

      nativeAudioHelper.reader.on("error", () => {
        stopNativeScreenAudioInternal();
      });
      nativeAudioHelper.proc.on("exit", () => {
        stopNativeScreenAudioInternal();
      });

      return { ok: true, captureMode, excludeRootPid, format: undefined };
    } catch (e) {
      stopNativeScreenAudioInternal();
      return { ok: false, error: e instanceof Error ? e.message : "Неизвестная ошибка запуска native audio." };
    }
  }
);

ipcMain.handle(
  "sloncord:install-update",
  async (event, installerUrl: string): Promise<{ ok: boolean; error?: string }> => {
    const sendProgress = (data: UpdateProgressPayload): void => {
      try {
        event.sender.send("sloncord:update-progress", data);
      } catch {
        /* ignore */
      }
    };

    try {
      sendProgress({ phase: "preparing" });
      const u = assertSafeInstallerUrl(String(installerUrl ?? ""));
      const parsedVer = parseUpdateVersionFromUrl(u);
      const pkgVer = await readPackageJsonVersion();
      // Prefer the TARGET version (from URL/metadata) over current app version.
      const ver = parsedVer || pkgVer || app.getVersion();
      const safeVer = String(ver || "")
        .trim()
        .replace(/[^\w.-]+/g, "-")
        .slice(0, 64) || "unknown";
      const safeName = `Sloncord-update-${safeVer}.exe`;
      const dest = path.join(app.getPath("temp"), safeName);

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

      /** Поток на диск + редкий прогресс по IPC — иначе главный процесс забивается тысячами send(). */
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
              hasTotal && bps > 0
                ? Math.max(0, Math.ceil((totalNum - downloaded) / bps))
                : null;
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

      /**
       * NSIS (assisted): тихая установка + запуск приложения после завершения — нужны оба флага.
       * /no-desktop-shortcut — не трогать ярлык на рабочем столе при обновлении (electron-builder StdUtils).
       */
      /**
       * electron-builder NSIS распознаёт именно `--force-run`, а не `/force-run`.
       * Иначе тихая установка завершается без запуска Sloncord.exe (installSection.nsh для assisted installer).
       */
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

const SLONCORD_GITHUB_REPO_DEFAULT = "anex-tim/sloncord";

const SLONCORD_INSTALLER_ASSET = "sloncord-setup-x64.exe";

function normalizeDesktopVersion(tag: string): string {
  return String(tag || "")
    .trim()
    .replace(/^v/i, "");
}

function compareDesktopSemver(a: string, b: string): number {
  const pa = normalizeDesktopVersion(a).split(".").map((x) => parseInt(x, 10));
  const pb = normalizeDesktopVersion(b).split(".").map((x) => parseInt(x, 10));
  const n = Math.max(pa.length, pb.length);
  for (let i = 0; i < n; i += 1) {
    const av = Number.isFinite(pa[i]) ? pa[i]! : 0;
    const bv = Number.isFinite(pb[i]) ? pb[i]! : 0;
    if (av > bv) return 1;
    if (av < bv) return -1;
  }
  return 0;
}

function metaFromGhRelease(data: {
  tag_name?: string;
  assets?: { name?: string; browser_download_url?: string; size?: number }[];
}): { version: string; downloadUrl: string; available: boolean; size?: number } | null {
  const version = normalizeDesktopVersion(String(data?.tag_name || ""));
  const asset = (data?.assets || []).find(
    (a) => String(a?.name || "").toLowerCase() === SLONCORD_INSTALLER_ASSET
  );
  const downloadUrl = String(asset?.browser_download_url || "").trim();
  if (!version || !downloadUrl) return null;
  return {
    version,
    downloadUrl,
    available: true,
    size: typeof asset?.size === "number" ? asset.size : undefined,
  };
}

function pickNewestDesktopMeta(
  items: { version: string; downloadUrl: string; available: boolean; size?: number }[]
): { version: string; downloadUrl: string; available: boolean; size?: number } | null {
  let best: { version: string; downloadUrl: string; available: boolean; size?: number } | null = null;
  for (const c of items) {
    if (!c.version || !c.downloadUrl || c.available === false) continue;
    if (!best || compareDesktopSemver(c.version, best.version) > 0) best = c;
  }
  return best;
}

async function fetchDesktopReleaseFromMainProcess(): Promise<{
  version: string;
  downloadUrl: string;
  available: boolean;
  size?: number;
} | null> {
  const envRepo = String(process.env.SLONCORD_GITHUB_REPO || "")
    .trim()
    .replace(/^https?:\/\/github\.com\//i, "")
    .replace(/\/$/, "");
  const repos = [envRepo, SLONCORD_GITHUB_REPO_DEFAULT].filter((r) => r.includes("/"));
  const seen = new Set<string>();
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "User-Agent": "Sloncord-Desktop",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  for (const repo of repos) {
    if (seen.has(repo)) continue;
    seen.add(repo);
    const candidates: { version: string; downloadUrl: string; available: boolean; size?: number }[] = [];
    try {
      const res = await fetch(`https://api.github.com/repos/${repo}/releases/latest`, {
        headers,
        cache: "no-store",
      });
      if (res.ok) {
        const data = (await res.json()) as {
          tag_name?: string;
          assets?: { name?: string; browser_download_url?: string; size?: number }[];
        };
        const m = metaFromGhRelease(data);
        if (m) candidates.push(m);
      }
    } catch {
      /* ignore */
    }
    try {
      const res = await fetch(`https://api.github.com/repos/${repo}/releases?per_page=30`, {
        headers,
        cache: "no-store",
      });
      if (res.ok) {
        const list = (await res.json()) as {
          tag_name?: string;
          assets?: { name?: string; browser_download_url?: string; size?: number }[];
        }[];
        for (const item of list || []) {
          const m = metaFromGhRelease(item);
          if (m) candidates.push(m);
        }
      }
    } catch {
      /* ignore */
    }
    try {
      const mRes = await fetch(
        `https://raw.githubusercontent.com/${repo}/main/releases/desktop-release.json?t=${Date.now()}`,
        { headers: { "User-Agent": "Sloncord-Desktop" }, cache: "no-store" }
      );
      if (mRes.ok) {
        const j = (await mRes.json()) as {
          version?: string;
          downloadUrl?: string;
          available?: boolean;
          size?: number;
        };
        const version = normalizeDesktopVersion(String(j?.version || ""));
        const downloadUrl = String(j?.downloadUrl || "").trim();
        if (version && downloadUrl && j?.available !== false) {
          candidates.push({ version, downloadUrl, available: true, size: j.size });
        }
      }
    } catch {
      /* ignore */
    }
    const best = pickNewestDesktopMeta(candidates);
    if (best) return best;
  }
  return null;
}

ipcMain.handle("sloncord:fetch-desktop-release", () => fetchDesktopReleaseFromMainProcess());

ipcMain.handle("sloncord:get-app-version", () => app.getVersion());

ipcMain.handle("sloncord:set-taskbar-badge", (_event, count: number) => {
  applyTaskbarBadge(count);
  return { ok: true };
});

ipcMain.handle(
  "sloncord:write-clipboard-text",
  (_event, text: string): { ok: boolean; error?: string } => {
    try {
      clipboard.writeText(String(text ?? ""));
      return { ok: true };
    } catch (e) {
      return {
        ok: false,
        error: e instanceof Error ? e.message : String(e),
      };
    }
  }
);

ipcMain.on("sloncord:window-minimize", () => {
  mainWindow?.minimize();
});

ipcMain.on("sloncord:window-maximize-toggle", () => {
  if (!mainWindow) return;
  if (mainWindow.isMaximized()) mainWindow.unmaximize();
  else mainWindow.maximize();
});

ipcMain.on("sloncord:window-close", () => {
  mainWindow?.close();
});

function getDistWebRoot(): string {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, "dist-web");
  }
  return path.join(__dirname, "..", "dist-web");
}

function mimeForDistFile(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  const map: Record<string, string> = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".mjs": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".ico": "image/x-icon",
    ".woff2": "font/woff2",
    ".webmanifest": "application/manifest+json",
  };
  return map[ext] || "application/octet-stream";
}

function resolveDistWebFile(requestUrl: string, distRoot: string): string | null {
  try {
    const u = new URL(requestUrl);
    let pathname = decodeURIComponent(u.pathname || "/");
    if (pathname === "/") pathname = "/index.html";
    const relative = pathname.replace(/^\/+/, "") || "index.html";
    const resolvedRoot = path.resolve(distRoot);
    const resolvedFile = path.resolve(path.join(distRoot, relative));
    const rel = path.relative(resolvedRoot, resolvedFile);
    if (rel.startsWith("..") || path.isAbsolute(rel)) return null;
    if (!fs.existsSync(resolvedFile) || !fs.statSync(resolvedFile).isFile()) return null;
    return resolvedFile;
  } catch {
    return null;
  }
}

/** Отдаём SPA как sloncord://… (secure context), а не file:// — нужно для getDisplayMedia. */
function registerSloncordProtocol(): void {
  const distRoot = path.normalize(getDistWebRoot());

  protocol.handle("sloncord", async (request) => {
    const resolvedFile = resolveDistWebFile(request.url, distRoot);
    if (!resolvedFile) {
      return new Response("Not found", {
        status: 404,
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
    }
    const cors = { "Access-Control-Allow-Origin": "*" };
    try {
      const res = await net.fetch(pathToFileURL(resolvedFile).toString());
      const headers = new Headers(res.headers);
      for (const [k, v] of Object.entries(cors)) headers.set(k, v);
      if (!headers.get("content-type")) {
        headers.set("content-type", mimeForDistFile(resolvedFile));
      }
      return new Response(res.body, { status: res.status, headers });
    } catch {
      const buf = await fs.promises.readFile(resolvedFile);
      return new Response(buf, {
        status: 200,
        headers: {
          "content-type": mimeForDistFile(resolvedFile),
          ...cors,
        },
      });
    }
  });
}

function showRendererLoadError(win: BrowserWindow, detail: string): void {
  const safe = String(detail || "unknown error")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
  const html = `<!doctype html><html lang="ru"><head><meta charset="utf-8"/><style>
    body{margin:0;font:14px "Segoe UI",system-ui,sans-serif;background:#313338;color:#dbdee1;display:flex;align-items:center;justify-content:center;min-height:100vh}
    .c{max-width:520px;padding:24px;background:#2b2d31;border-radius:12px;border:1px solid #1e1f22}
    h1{margin:0 0 12px;font-size:18px}p{margin:0;line-height:1.45;color:#b5bac1;word-break:break-word}
  </style></head><body><div class="c"><h1>Не удалось загрузить Sloncord</h1><p>${safe}</p></div></body></html>`;
  try {
    void win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
  } catch {
    /* ignore */
  }
}

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    title: `Sloncord - ${app.getVersion()}`,
    frame: false,
    backgroundColor: "#313338",
    icon: getWindowIcon(),
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  mainWindow = win;
  win.once("ready-to-show", () => {
    applyTaskbarBadge(pendingTaskbarBadge);
  });
  win.on("show", () => {
    applyTaskbarBadge(pendingTaskbarBadge);
  });
  win.on("focus", () => {
    applyTaskbarBadge(pendingTaskbarBadge);
  });
  if (argvRequestsStartMinimized) {
    win.once("ready-to-show", () => {
      try {
        win.minimize();
      } catch {
        /* ignore */
      }
    });
  }
  win.on("closed", () => {
    if (mainWindow === win) mainWindow = null;
  });

  win.on("close", (e) => {
    // Windows/Linux: close button should minimize-to-tray (hide) instead of quitting.
    if (isQuitting) return;
    try {
      e.preventDefault();
      // Keep the window in the taskbar (minimize), but also keep tray controls.
      win.minimize();
      ensureTray();
    } catch {
      /* ignore */
    }
  });

  // Keep renderer in sync for titlebar icons.
  win.on("maximize", sendWindowStateToRenderer);
  win.on("unmaximize", sendWindowStateToRenderer);
  win.on("enter-full-screen", sendWindowStateToRenderer);
  win.on("leave-full-screen", sendWindowStateToRenderer);
  win.on("show", sendWindowStateToRenderer);

  win.webContents.setWindowOpenHandler(({ url }) => {
    try {
      const invite = parseInviteCodeFromWebUrl(String(url || ""));
      if (invite) {
        try {
          if (win.isMinimized()) win.restore();
          win.show();
          win.focus();
        } catch { /* ignore */ }
        try {
          win.webContents.send("sloncord:open-invite", { inviteCode: invite });
        } catch { /* ignore */ }
        return { action: "deny" };
      }
    } catch { /* ignore */ }
    shell.openExternal(url);
    return { action: "deny" };
  });

  win.webContents.on("will-navigate", (event, url) => {
    const invite = parseInviteCodeFromWebUrl(String(url || ""));
    if (!invite) return;
    event.preventDefault();
    try {
      if (win.isMinimized()) win.restore();
      win.show();
      win.focus();
    } catch { /* ignore */ }
    try {
      win.webContents.send("sloncord:open-invite", { inviteCode: invite });
    } catch { /* ignore */ }
  });

  const useVite = process.env.SLONCORD_USE_VITE === "1";
  const viteUrl = process.env.SLONCORD_VITE_URL || "http://localhost:5173";

  if (useVite) {
    void win.loadURL(viteUrl);
    win.webContents.openDevTools({ mode: "detach" });
    return;
  }

  win.webContents.on("did-fail-load", (_ev, code, desc, url, isMainFrame) => {
    if (!isMainFrame || code === -3) return;
    showRendererLoadError(win, `${desc} (${code}) — ${url}`);
  });

  win.webContents.on("console-message", (_ev, level, message, line, sourceId) => {
    if (level >= 2 && !app.isPackaged) {
      console.error(`[renderer ${level}] ${message} @ ${sourceId}:${line}`);
    }
  });

  void win.loadURL("sloncord:///index.html").catch((err) => {
    showRendererLoadError(
      win,
      err instanceof Error ? err.message : String(err)
    );
  });
}

const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  app.quit();
} else {
  app.on("second-instance", (_e, argv) => {
    const win = mainWindow;
    if (win) {
      if (win.isMinimized()) win.restore();
      win.show();
      win.focus();
    }
    const line = argv.find((a) => String(a).includes("sloncord-app://"));
    if (line) {
      dispatchCallActionFromProtocol(line, () => mainWindow);
    }
  });

  app.whenReady().then(() => {
    app.setAppUserModelId("com.sloncord.desktop");
    if (app.isPackaged) {
      try {
        app.setAsDefaultProtocolClient("sloncord-app");
      } catch {
        /* ignore */
      }
    }

    registerNotificationIpc(() => mainWindow);

    if (process.platform === "win32") {
      const line = process.argv.find((a) => String(a).includes("sloncord-app://"));
      if (line) {
        setTimeout(() => {
          dispatchCallActionFromProtocol(line, () => mainWindow);
        }, 600);
      }
    }

    installApiCertificateTrust();
    installDesktopClientRequestHeaders();

    session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => {
      if (
        permission === "display-capture" ||
        permission === "media" ||
        permission === "audioCapture"
      ) {
        callback(true);
      } else {
        callback(false);
      }
    });

    registerDisplayPickerIpc();
    session.defaultSession.setDisplayMediaRequestHandler((request, callback) => {
      void openDisplayMediaPickerWindow(request, callback).catch(() => callback(null));
    });
    registerSloncordProtocol();
    createWindow();
    ensureTray();
    applyLoginItemFromStore();
    applyVoiceHotkeysFromStore();

    app.on("before-quit", () => {
      isQuitting = true;
      unregisterTrackedVoiceHotkeys();
    });

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
      else {
        try {
          mainWindow?.show();
          mainWindow?.focus();
        } catch {
          /* ignore */
        }
      }
    });
  });

  app.on("window-all-closed", () => {
    // With tray mode we keep the app alive even when window is hidden/closed.
    if (process.platform === "darwin") return;
    if (!isQuitting) return;
    app.quit();
  });
}

ipcMain.handle("sloncord:get-window-state", () => {
  try {
    if (!mainWindow || mainWindow.isDestroyed()) return { maximized: false, fullscreen: false };
    return { maximized: mainWindow.isMaximized(), fullscreen: mainWindow.isFullScreen() };
  } catch {
    return { maximized: false, fullscreen: false };
  }
});
