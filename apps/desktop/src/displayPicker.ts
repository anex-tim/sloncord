import { BrowserWindow, desktopCapturer, ipcMain } from "electron";
import path from "node:path";

type DisplayMediaCb = (
  streams: {
    video?: Electron.DesktopCapturerSource;
    audio?: "loopback" | "loopbackWithMute";
  } | null
) => void;

export type DisplayCaptureProfile = {
  maxHeight: number;
  frameRate: number;
};

let pendingDisplayCallback: DisplayMediaCb | null = null;
let pendingAudioRequested = false;
let sourcesScreen = new Map<string, Electron.DesktopCapturerSource>();
let sourcesWindow = new Map<string, Electron.DesktopCapturerSource>();
let combinedSourcesById = new Map<string, Electron.DesktopCapturerSource>();
let pickerWin: BrowserWindow | null = null;

/** Заполняется при подтверждении выбора; забирается renderer через takeDisplayCaptureProfile. */
let pendingCaptureProfile: DisplayCaptureProfile | null = null;

/** Заполняется при подтверждении выбора; забирается renderer через takeDisplaySelection. */
let pendingDisplaySelection: {
  tab: "screen" | "window";
  sourceId: string;
  withSystemAudio: boolean;
} | null = null;

export function takeDisplaySelectionNow(): {
  tab: "screen" | "window";
  sourceId: string;
  withSystemAudio: boolean;
} | null {
  const s = pendingDisplaySelection;
  pendingDisplaySelection = null;
  return s;
}

/** true сразу при входе в openDisplayMediaPickerWindow до завершения сессии (защита от гонок до await). */
let displayPickerBusy = false;

/** Chromium callback можно вызвать только один раз; иначе «Error starting capture» и повторное окно. */
let pickerCallbackUsed = false;

/**
 * На Windows/Chromium иногда после закрытия окна выбора (cb(null)) прилетает
 * ещё один displayMediaRequest сразу же, без нового клика пользователя.
 * Чтобы не показывать picker дважды, подавляем повторное открытие на короткое окно времени.
 */
let suppressOpenUntilMs = 0;

function clearSourceMaps(): void {
  sourcesScreen.clear();
  sourcesWindow.clear();
  combinedSourcesById.clear();
}

function invokeChromiumPickerCallback(cb: DisplayMediaCb | null, payload: Parameters<DisplayMediaCb>[0]): void {
  if (!cb || pickerCallbackUsed) return;
  pickerCallbackUsed = true;
  pendingAudioRequested = false;
  clearSourceMaps();
  displayPickerBusy = false;
  try {
    cb(payload);
  } catch {
    /* ignore */
  }
}

function destroyPickerWindow(): void {
  try {
    pickerWin?.destroy();
  } catch {
    /* ignore */
  }
  pickerWin = null;
}

export function registerDisplayPickerIpc(): void {
  ipcMain.removeHandler("display-picker:list");
  ipcMain.removeHandler("display-picker:get-options");
  ipcMain.removeHandler("display-picker:confirm");
  ipcMain.removeHandler("display-picker:cancel");
  ipcMain.removeHandler("sloncord:take-display-capture-profile");
  ipcMain.removeHandler("sloncord:take-display-selection");

  ipcMain.handle("display-picker:list", async (_e, tab: "screen" | "window") => {
    const m = tab === "screen" ? sourcesScreen : sourcesWindow;
    const out: { id: string; name: string; thumbnail: string }[] = [];
    for (const [id, s] of m) {
      out.push({
        id,
        name: s.name,
        thumbnail: s.thumbnail.toDataURL(),
      });
    }
    return out;
  });

  ipcMain.handle("display-picker:get-options", async () => ({
    audioRequested: pendingAudioRequested,
  }));

  ipcMain.handle(
    "display-picker:confirm",
    async (_e, id: string, withSystemAudio: boolean, maxHeight: number, frameRate: number) => {
      confirmPicker(id, withSystemAudio, {
        maxHeight: Number(maxHeight) || 1080,
        frameRate: Number(frameRate) || 30,
      });
    }
  );

  ipcMain.handle("display-picker:cancel", async () => {
    cancelPicker();
  });

  ipcMain.handle("sloncord:take-display-capture-profile", async () => {
    const p = pendingCaptureProfile;
    pendingCaptureProfile = null;
    return p;
  });

  ipcMain.handle("sloncord:take-display-selection", async () => {
    return takeDisplaySelectionNow();
  });
}

function cancelPicker(): void {
  const cb = pendingDisplayCallback;
  pendingDisplayCallback = null;
  pendingCaptureProfile = null;
  pendingDisplaySelection = null;
  suppressOpenUntilMs = Date.now() + 1200;
  invokeChromiumPickerCallback(cb, null);
  destroyPickerWindow();
}

function confirmPicker(id: string, withSystemAudio: boolean, profile: DisplayCaptureProfile): void {
  if (pickerCallbackUsed) {
    destroyPickerWindow();
    return;
  }

  const cb = pendingDisplayCallback;
  const audioReq = pendingAudioRequested;
  const src = combinedSourcesById.get(id);
  const isScreenSource = sourcesScreen.has(id) || String(id || "").startsWith("screen:");
  const isWindowSource = sourcesWindow.has(id) || String(id || "").startsWith("window:");

  pendingDisplayCallback = null;
  pendingAudioRequested = false;
  clearSourceMaps();

  if (!cb) {
    destroyPickerWindow();
    displayPickerBusy = false;
    return;
  }

  if (!src) {
    invokeChromiumPickerCallback(cb, null);
    destroyPickerWindow();
    return;
  }

  pendingCaptureProfile = profile;
  pendingDisplaySelection = {
    tab: isWindowSource ? "window" : "screen",
    sourceId: String(id || ""),
    withSystemAudio: !!withSystemAudio,
  };
  pickerCallbackUsed = true;
  displayPickerBusy = false;

  try {
    /**
     * Звук демонстрации захватывает native WASAPI helper (exclude Sloncord), не Chromium loopback.
     * Chromium `audio: "loopback"` тянет весь системный микс, включая голосовой чат Sloncord →
     * зрители слышат сами себя в дорожке screenAudio. Видео — только из getDisplayMedia.
     */
    void isScreenSource;
    void isWindowSource;
    void audioReq;
    void withSystemAudio;
    cb({ video: src });
  } catch {
    /* ignore */
  }

  destroyPickerWindow();
}

export async function openDisplayMediaPickerWindow(
  request: {
    audioRequested: boolean;
    videoRequested: boolean;
    userGesture: boolean;
  },
  callback: DisplayMediaCb
): Promise<void> {
  const now0 = Date.now();
  if (now0 < suppressOpenUntilMs) {
    callback(null);
    return;
  }
  /** pending / busy — параллельный второй getDisplayMedia; pickerCallbackUsed сбрасываем ниже для новой сессии */
  if (pendingDisplayCallback || displayPickerBusy) {
    callback(null);
    return;
  }

  displayPickerBusy = true;
  pickerCallbackUsed = false;

  let screens: Electron.DesktopCapturerSource[];
  let wins: Electron.DesktopCapturerSource[];
  try {
    [screens, wins] = await Promise.all([
      desktopCapturer.getSources({
        types: ["screen"],
        thumbnailSize: { width: 320, height: 180 },
        fetchWindowIcons: false,
      }),
      desktopCapturer.getSources({
        types: ["window"],
        thumbnailSize: { width: 320, height: 180 },
        fetchWindowIcons: true,
      }),
    ]);
  } catch {
    displayPickerBusy = false;
    pickerCallbackUsed = false;
    callback(null);
    return;
  }

  if (!screens.length && !wins.length) {
    displayPickerBusy = false;
    pickerCallbackUsed = false;
    callback(null);
    return;
  }

  pendingDisplayCallback = callback;
  pendingAudioRequested = !!request.audioRequested;
  pendingCaptureProfile = null;
  pendingDisplaySelection = null;

  sourcesScreen = new Map(screens.map((s) => [s.id, s]));
  sourcesWindow = new Map(wins.map((s) => [s.id, s]));
  combinedSourcesById = new Map<string, Electron.DesktopCapturerSource>([
    ...sourcesScreen,
    ...sourcesWindow,
  ]);

  const parent =
    BrowserWindow.getFocusedWindow() ??
    BrowserWindow.getAllWindows().find((w) => !w.isDestroyed());

  pickerWin = new BrowserWindow({
    parent: parent ?? undefined,
    /** modal даёт странные циклы фокуса на Windows и повторные запросы getDisplayMedia */
    modal: false,
    width: 780,
    height: 660,
    minWidth: 540,
    minHeight: 480,
    title: "Демонстрация экрана — Sloncord",
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "picker-preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
    show: false,
  });

  pickerWin.once("ready-to-show", () => {
    pickerWin?.show();
  });

  pickerWin.on("closed", () => {
    pickerWin = null;
    if (!pickerCallbackUsed && pendingDisplayCallback) {
      const cb = pendingDisplayCallback;
      pendingDisplayCallback = null;
      pendingCaptureProfile = null;
      pendingAudioRequested = false;
      suppressOpenUntilMs = Date.now() + 1200;
      invokeChromiumPickerCallback(cb, null);
    }
    displayPickerBusy = false;
    clearSourceMaps();
  });

  const htmlPath = path.join(__dirname, "..", "resources", "display-picker.html");
  try {
    await pickerWin.loadFile(htmlPath);
  } catch {
    cancelPicker();
  }
}
