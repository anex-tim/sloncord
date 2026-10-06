export {};

declare global {
  interface Window {
    slonmod?: {
      getApiBase?: () => string;
      setApiBase?: (url: string) => void;
      getAppVersion?: () => Promise<string>;
      installUpdate?: (installerUrl: string) => Promise<{ ok: boolean; error?: string }>;
      minimizeWindow?: () => void;
      maximizeWindowToggle?: () => void;
      closeWindow?: () => void;
      getWindowState?: () => Promise<{ maximized: boolean; fullscreen: boolean }>;
      onWindowStateChanged?: (cb: (s: { maximized: boolean; fullscreen: boolean }) => void) => () => void;
      setWindowFullscreen?: (flag: boolean) => Promise<{ ok: boolean }>;
      onUpdateProgress?: (cb: (detail: unknown) => void) => () => void;
    };
  }
}
