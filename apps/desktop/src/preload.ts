import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("sloncord", {
  getApiBase: (): string => ipcRenderer.sendSync("sloncord:get-api-base") as string,
  setApiBase: (url: string): void => {
    ipcRenderer.sendSync("sloncord:set-api-base", url);
  },
  takeDisplayCaptureProfile: (): Promise<{ maxHeight: number; frameRate: number } | null> =>
    ipcRenderer.invoke("sloncord:take-display-capture-profile"),
  takeDisplaySelection: (): Promise<{ tab: "screen" | "window"; sourceId: string; withSystemAudio: boolean } | null> =>
    ipcRenderer.invoke("sloncord:take-display-selection"),
  startNativeScreenAudio: (
    selection?: { tab: "screen" | "window"; sourceId: string; withSystemAudio: boolean } | null
  ): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke("sloncord:start-native-screen-audio", selection ?? undefined),
  stopNativeScreenAudio: (): Promise<{ ok: boolean }> => ipcRenderer.invoke("sloncord:stop-native-screen-audio"),
  startNativeVoice: (cfg: {
    udpHost: string;
    udpPort: number;
    sessionToken: string;
    sessionId: number;
    roomId: string;
    userId: string;
    muted?: boolean;
    deafened?: boolean;
  }): Promise<{ ok: boolean; error?: string }> => ipcRenderer.invoke("sloncord:start-native-voice", cfg),
  stopNativeVoice: (): Promise<{ ok: boolean }> => ipcRenderer.invoke("sloncord:stop-native-voice"),
  setNativeVoiceMuted: (muted: boolean): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke("sloncord:set-native-voice-muted", muted),
  setNativeVoiceDeafened: (deafened: boolean): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke("sloncord:set-native-voice-deafened", deafened),
  setNativeVoiceInputDevice: (deviceId: string): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke("sloncord:set-native-voice-input-device", deviceId),
  setNativeVoiceOutputDevice: (deviceId: string): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke("sloncord:set-native-voice-output-device", deviceId),
  setNativeVoiceProcessing: (opts: Record<string, unknown>): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke("sloncord:set-native-voice-processing", opts),
  setNativeVoiceMicGain: (gain: number): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke("sloncord:set-native-voice-mic-gain", gain),
  setNativeVoiceSpeakerGain: (gain: number): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke("sloncord:set-native-voice-speaker-gain", gain),
  setNativeVoiceWatchScreen: (sessionId: number): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke("sloncord:set-native-voice-watch-screen", sessionId),
  setDisplayCaptureLive: (live: boolean): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke("sloncord:set-display-capture-live", !!live),
  onNativeVoiceSpeaking: (cb: (detail: { speaking: boolean; level: number; threshold?: number }) => void): (() => void) => {
    const fn = (_e: unknown, detail: { speaking: boolean; level: number }): void => {
      cb(detail);
    };
    ipcRenderer.on("sloncord:native-voice-speaking", fn);
    return () => {
      ipcRenderer.removeListener("sloncord:native-voice-speaking", fn);
    };
  },
  sendNativeVideoFrame: (jpegBase64: string): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke("sloncord:send-native-video-frame", jpegBase64),
  onNativeRemoteVideo: (
    cb: (detail: { sessionId: number; jpegBase64: string }) => void
  ): (() => void) => {
    const fn = (_e: unknown, detail: { sessionId: number; jpegBase64: string }): void => {
      cb(detail);
    };
    ipcRenderer.on("sloncord:native-remote-video", fn);
    return () => {
      ipcRenderer.removeListener("sloncord:native-remote-video", fn);
    };
  },
  onNativeVoiceError: (cb: (msg: string) => void): (() => void) => {
    const fn = (_e: unknown, msg: string): void => {
      cb(String(msg || ""));
    };
    ipcRenderer.on("sloncord:native-voice-error", fn);
    return () => {
      ipcRenderer.removeListener("sloncord:native-voice-error", fn);
    };
  },
  onNativeScreenAudio: (cb: (chunk: ArrayBuffer) => void): (() => void) => {
    const fn = (_e: unknown, chunk: Uint8Array): void => {
      const buf = chunk?.buffer?.slice(chunk.byteOffset, chunk.byteOffset + chunk.byteLength) ?? new ArrayBuffer(0);
      cb(buf);
    };
    ipcRenderer.on("sloncord:native-screen-audio", fn);
    return () => {
      ipcRenderer.removeListener("sloncord:native-screen-audio", fn);
    };
  },
  minimizeWindow: (): void => {
    ipcRenderer.send("sloncord:window-minimize");
  },
  maximizeWindowToggle: (): void => {
    ipcRenderer.send("sloncord:window-maximize-toggle");
  },
  closeWindow: (): void => {
    ipcRenderer.send("sloncord:window-close");
  },
  getWindowState: (): Promise<{ maximized: boolean; fullscreen: boolean }> =>
    ipcRenderer.invoke("sloncord:get-window-state"),
  onWindowStateChanged: (cb: (s: { maximized: boolean; fullscreen: boolean }) => void): (() => void) => {
    const fn = (_e: unknown, s: { maximized: boolean; fullscreen: boolean }): void => {
      cb(s);
    };
    ipcRenderer.on("sloncord:window-state", fn);
    return () => {
      ipcRenderer.removeListener("sloncord:window-state", fn);
    };
  },
  /** Если Fullscreen API не сработал (редко), резерв — полноэкранное окно приложения. */
  setWindowFullscreen: (flag: boolean): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke("sloncord:set-window-fullscreen", flag),
  getAppVersion: (): Promise<string> => ipcRenderer.invoke("sloncord:get-app-version"),
  fetchDesktopReleaseFromMain: (): Promise<{
    version?: string;
    downloadUrl?: string;
    available?: boolean;
    size?: number;
  } | null> => ipcRenderer.invoke("sloncord:fetch-desktop-release"),
  writeClipboardText: (text: string): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke("sloncord:write-clipboard-text", text),
  installDesktopUpdate: (installerUrl: string): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke("sloncord:install-update", installerUrl),
  onUpdateProgress: (cb: (detail: unknown) => void): (() => void) => {
    const fn = (_e: unknown, detail: unknown): void => {
      cb(detail);
    };
    ipcRenderer.on("sloncord:update-progress", fn);
    return () => {
      ipcRenderer.removeListener("sloncord:update-progress", fn);
    };
  },
  isMainWindowFocused: (): Promise<boolean> => ipcRenderer.invoke("sloncord:is-main-window-focused"),
  setTaskbarBadge: (count: number): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke("sloncord:set-taskbar-badge", count),
  showNativeMessageNotification: (o: {
    title: string;
    body: string;
  }): Promise<{ ok: boolean }> => ipcRenderer.invoke("sloncord:notify-message", o),
  showNativeIncomingCall: (p: {
    callId: string;
    channelId: string;
    fromUserId: string;
    fromNickname: string;
  }): Promise<{ ok: boolean }> => ipcRenderer.invoke("sloncord:notify-incoming-call", p),
  onCallNotifAction: (cb: (detail: {
    callId: string;
    channelId: string;
    fromUserId: string;
    action: string;
  }) => void): (() => void) => {
    const fn = (
      _e: unknown,
      detail: { callId: string; channelId: string; fromUserId: string; action: string }
    ): void => {
      cb(detail);
    };
    ipcRenderer.on("sloncord:call-notif-action", fn);
    return () => {
      ipcRenderer.removeListener("sloncord:call-notif-action", fn);
    };
  },
  onOpenInvite: (cb: (detail: { inviteCode: string }) => void): (() => void) => {
    const fn = (_e: unknown, detail: { inviteCode: string }): void => {
      cb(detail);
    };
    ipcRenderer.on("sloncord:open-invite", fn);
    return () => {
      ipcRenderer.removeListener("sloncord:open-invite", fn);
    };
  },
  getDesktopPrefs: (): Promise<{
    hotkeyToggleMic: string;
    hotkeyToggleDeafen: string;
    loginOpenAtLogin: boolean;
    loginStartHidden: boolean;
  }> => ipcRenderer.invoke("sloncord:get-desktop-prefs"),
  setDesktopPrefs: (
    patch: Partial<{
      hotkeyToggleMic: string;
      hotkeyToggleDeafen: string;
      loginOpenAtLogin: boolean;
      loginStartHidden: boolean;
    }>
  ): Promise<{ ok: boolean }> => ipcRenderer.invoke("sloncord:set-desktop-prefs", patch),
  onHotkeyToggleMic: (cb: () => void): (() => void) => {
    const fn = (): void => {
      cb();
    };
    ipcRenderer.on("sloncord:hotkey-toggle-mic", fn);
    return () => {
      ipcRenderer.removeListener("sloncord:hotkey-toggle-mic", fn);
    };
  },
  onHotkeyToggleDeafen: (cb: () => void): (() => void) => {
    const fn = (): void => {
      cb();
    };
    ipcRenderer.on("sloncord:hotkey-toggle-deafen", fn);
    return () => {
      ipcRenderer.removeListener("sloncord:hotkey-toggle-deafen", fn);
    };
  },
});
