export {};

declare global {
  interface Window {
    sloncord?: {
      getApiBase: () => string;
      setApiBase: (url: string) => void;
      /** После успешного getDisplayMedia в Electron возвращает настройки из окна выбора и сбрасывает их. */
      takeDisplayCaptureProfile?: () => Promise<{
        maxHeight: number;
        frameRate: number;
      } | null>;
      takeDisplaySelection?: () => Promise<{
        tab: "screen" | "window";
        sourceId: string;
        withSystemAudio: boolean;
      } | null>;
      startNativeScreenAudio?: (
        selection?: { tab: "screen" | "window"; sourceId: string; withSystemAudio: boolean } | null
      ) => Promise<{ ok: boolean; error?: string; captureMode?: "exclude-tree" | "dual-subtract" | "subtract-fallback"; excludeRootPid?: number }>;
      stopNativeScreenAudio?: () => Promise<{ ok: boolean }>;
      onNativeScreenAudio?: (cb: (chunk: ArrayBuffer) => void) => (() => void) | void;
      minimizeWindow?: () => void;
      maximizeWindowToggle?: () => void;
      closeWindow?: () => void;
      getWindowState?: () => Promise<{ maximized: boolean; fullscreen: boolean }>;
      onWindowStateChanged?: (cb: (s: { maximized: boolean; fullscreen: boolean }) => void) => (() => void) | void;
      /** Резерв, если Element.requestFullscreen не сработал (десктоп). */
      setWindowFullscreen?: (flag: boolean) => Promise<{ ok: boolean }>;
      getAppVersion?: () => Promise<string>;
      /** В Electron надёжнее, чем navigator.clipboard на кастомном протоколе. */
      writeClipboardText?: (text: string) => Promise<{ ok: boolean; error?: string }>;
      /** Скачивание с прогрессом, тихая установка NSIS и выход (упакованная Windows-сборка). */
      installDesktopUpdate?: (
        installerUrl: string
      ) => Promise<{ ok: boolean; error?: string }>;
      onUpdateProgress?: (cb: (detail: unknown) => void) => (() => void) | void;
      isMainWindowFocused?: () => Promise<boolean>;
      setTaskbarBadge?: (count: number) => Promise<{ ok: boolean }>;
      showNativeMessageNotification?: (o: {
        title: string;
        body: string;
      }) => Promise<{ ok: boolean }>;
      showNativeIncomingCall?: (p: {
        callId: string;
        channelId: string;
        fromUserId: string;
        fromNickname: string;
      }) => Promise<{ ok: boolean }>;
      onCallNotifAction?: (cb: (detail: {
        callId: string;
        channelId: string;
        fromUserId: string;
        action: string;
      }) => void) => (() => void) | void;
      onOpenInvite?: (cb: (detail: { inviteCode: string }) => void) => (() => void) | void;
      getDesktopPrefs?: () => Promise<{
        hotkeyToggleMic: string;
        hotkeyToggleDeafen: string;
        loginOpenAtLogin: boolean;
        loginStartHidden: boolean;
      }>;
      setDesktopPrefs?: (
        patch: Partial<{
          hotkeyToggleMic: string;
          hotkeyToggleDeafen: string;
          loginOpenAtLogin: boolean;
          loginStartHidden: boolean;
        }>
      ) => Promise<{ ok: boolean }>;
      onHotkeyToggleMic?: (cb: () => void) => (() => void) | void;
      onHotkeyToggleDeafen?: (cb: () => void) => (() => void) | void;
    };
    /** Кэш модуля mediasoup-client после динамического import(). */
    mediasoupClient?: typeof import("mediasoup-client");
  }
}
