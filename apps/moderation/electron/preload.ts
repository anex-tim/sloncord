import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("slonmod", {
  getApiBase: (): string => ipcRenderer.sendSync("slonmod:get-api-base") as string,
  setApiBase: (url: string): void => {
    ipcRenderer.sendSync("slonmod:set-api-base", url);
  },
  getAppVersion: (): Promise<string> => ipcRenderer.invoke("slonmod:get-app-version") as Promise<string>,
  fetchRelease: (): Promise<{ version: string; downloadUrl: string; available?: boolean; size?: number } | null> =>
    ipcRenderer.invoke("slonmod:fetch-release") as Promise<{
      version: string;
      downloadUrl: string;
      available?: boolean;
      size?: number;
    } | null>,
  installUpdate: (installerUrl: string): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke("slonmod:install-update", installerUrl) as Promise<{ ok: boolean; error?: string }>,
  minimizeWindow: (): void => {
    ipcRenderer.send("slonmod:window-minimize");
  },
  maximizeWindowToggle: (): void => {
    ipcRenderer.send("slonmod:window-maximize-toggle");
  },
  closeWindow: (): void => {
    ipcRenderer.send("slonmod:window-close");
  },
  getWindowState: (): Promise<{ maximized: boolean; fullscreen: boolean }> =>
    ipcRenderer.invoke("slonmod:get-window-state") as Promise<{ maximized: boolean; fullscreen: boolean }>,
  onWindowStateChanged: (cb: (s: { maximized: boolean; fullscreen: boolean }) => void): (() => void) => {
    const fn = (_e: unknown, s: { maximized: boolean; fullscreen: boolean }): void => {
      cb(s);
    };
    ipcRenderer.on("slonmod:window-state", fn);
    return () => {
      ipcRenderer.removeListener("slonmod:window-state", fn);
    };
  },
  setWindowFullscreen: (flag: boolean): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke("slonmod:set-window-fullscreen", flag) as Promise<{ ok: boolean }>,
  onUpdateProgress: (cb: (detail: unknown) => void): (() => void) => {
    const fn = (_e: unknown, detail: unknown): void => {
      cb(detail);
    };
    ipcRenderer.on("slonmod:update-progress", fn);
    return () => {
      ipcRenderer.removeListener("slonmod:update-progress", fn);
    };
  },
});
