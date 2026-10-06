import { getApiBase } from "../config/apiBase";
import { createNativePresenceClient } from "./nativePresenceClient";
import { deriveNativeSessionId } from "./nativeSessionId";
import { createVoiceSessionState } from "./voiceSessionState";

function resolveNativeUdpHost(host: string): string {
  const h = String(host || "").trim();
  if (h && h !== "127.0.0.1" && h !== "localhost" && h !== "::1") return h;
  try {
    const base = getApiBase();
    if (base) return new URL(base).hostname;
  } catch {
    /* ignore */
  }
  return h || "127.0.0.1";
}

export type NativeVoiceJoinCredentials = {
  udpHost: string;
  udpPort: number;
  sessionToken: string;
  sessionId: number;
};

export type NativeVoiceSessionOptions = {
  token: string;
  roomId: string;
  selfUserId: string;
  remoteVideoHost?: HTMLElement | null;
  onState: (patch: Record<string, unknown>) => void;
  fetchNativeJoin: () => Promise<NativeVoiceJoinCredentials>;
  onForceLeave: () => void;
  onVoiceMove?: (channelId: string) => void;
  onScreenAudioError?: (msg: string) => void;
  onNativeVoiceError?: (msg: string) => void;
};

type SloncordNativeVoiceBridge = {
  startNativeVoice?: (cfg: NativeVoiceJoinCredentials & { roomId: string; userId: string; muted: boolean; deafened: boolean }) => Promise<{ ok: boolean; error?: string }>;
  stopNativeVoice?: () => Promise<{ ok: boolean }>;
  setNativeVoiceMuted?: (muted: boolean) => Promise<{ ok: boolean }>;
  setNativeVoiceDeafened?: (deafened: boolean) => Promise<{ ok: boolean }>;
  setNativeVoiceInputDevice?: (deviceId: string) => Promise<{ ok: boolean }>;
  setNativeVoiceOutputDevice?: (deviceId: string) => Promise<{ ok: boolean }>;
  sendNativeVideoFrame?: (jpegBase64: string) => Promise<{ ok: boolean }>;
  onNativeVoiceSpeaking?: (cb: (detail: { speaking: boolean; level: number }) => void) => () => void;
  onNativeRemoteVideo?: (cb: (detail: { sessionId: number; jpegBase64: string }) => void) => () => void;
  onNativeVoiceError?: (cb: (msg: string) => void) => () => void;
  takeDisplaySelection?: () => Promise<{ tab: "screen" | "window"; sourceId: string; withSystemAudio: boolean } | null>;
};

function bridge(): SloncordNativeVoiceBridge | null {
  try {
    return (window as unknown as { sloncord?: SloncordNativeVoiceBridge }).sloncord ?? null;
  } catch {
    return null;
  }
}

function peerDomId(userId: string) {
  return `remote-video-${String(userId).replace(/[^a-f0-9-]/gi, "x")}`;
}

export function createNativeVoiceSession(opts: NativeVoiceSessionOptions) {
  let destroyed = false;
  let muted = false;
  let deafened = false;
  let speaking = false;
  let lastRoster: string[] = [];
  let speakingTimer: ReturnType<typeof setInterval> | null = null;
  let unsubSpeaking: (() => void) | null = null;
  let unsubError: (() => void) | null = null;
  let unsubRemoteVideo: (() => void) | null = null;
  let lastNativeUdpRefreshAt = 0;
  let nativeUdpRefreshInFlight: Promise<void> | null = null;
  let screenSharing = false;
  let screenStream: MediaStream | null = null;
  let screenCaptureTimer: ReturnType<typeof setInterval> | null = null;
  let screenVideoEl: HTMLVideoElement | null = null;
  let screenCanvas: HTMLCanvasElement | null = null;
  const screenUrlByUserId = new Map<string, string>();
  const sessionToUserId = new Map<number, string>();

  const voiceFsm = createVoiceSessionState();

  function setState(patch: Record<string, unknown>) {
    opts.onState(patch);
  }

  async function rebuildSessionMap() {
    sessionToUserId.clear();
    for (const uid of lastRoster) {
      if (!uid || uid === String(opts.selfUserId)) continue;
      try {
        const sid = await deriveNativeSessionId(uid, opts.roomId);
        sessionToUserId.set(sid, uid);
      } catch {
        /* ignore */
      }
    }
    const selfSid = await deriveNativeSessionId(String(opts.selfUserId), opts.roomId);
    sessionToUserId.set(selfSid, String(opts.selfUserId));
  }

  const presence = createNativePresenceClient({
    token: opts.token,
    roomId: opts.roomId,
    isDestroyed: () => destroyed,
    voiceFsm,
    onForceLeave: opts.onForceLeave,
    onVoiceMove: opts.onVoiceMove,
    onNativeReady: () => {
      setState({ mediaLinkReady: true });
    },
    onReconnectSuccess: () => {
      if (destroyed) return;
      const now = Date.now();
      if (now - lastNativeUdpRefreshAt < 4000) return;
      void refreshNativeUdp().catch(() => {});
    },
    onRoomRoster: (msg) => {
      const ids = Array.isArray(msg.userIds) ? msg.userIds.map((x) => String(x)) : [];
      lastRoster = ids;
      void rebuildSessionMap();
      setState({
        rosterUserIds: ids,
        remotePeerUserIds: ids.filter((id) => id && id !== String(opts.selfUserId)),
        peers: Math.max(0, ids.length - 1),
        speakingUserIds: Array.isArray(msg.speakingUserIds) ? msg.speakingUserIds.map(String) : [],
        screenShareUserIds: Array.isArray(msg.screenShareUserIds) ? msg.screenShareUserIds.map(String) : [],
        mutedUserIds: Array.isArray(msg.mutedUserIds) ? msg.mutedUserIds.map(String) : [],
        deafenedUserIds: Array.isArray(msg.deafenedUserIds) ? msg.deafenedUserIds.map(String) : [],
      });
    },
  });

  function sendPresence(obj: Record<string, unknown>) {
    presence.send(obj);
  }

  function readPersistedMuteDeafen() {
    try {
      deafened = localStorage.getItem("sloncord_voice_deafened") === "1";
      muted = localStorage.getItem("sloncord_voice_mic_enabled") === "0" || deafened;
    } catch {
      muted = false;
      deafened = false;
    }
  }

  async function refreshNativeUdp() {
    if (destroyed) return;
    if (nativeUdpRefreshInFlight) {
      await nativeUdpRefreshInFlight.catch(() => {});
      return;
    }
    nativeUdpRefreshInFlight = (async () => {
      if (destroyed) return;
      const creds = await opts.fetchNativeJoin();
      if (destroyed) return;
      const b = bridge();
      if (!b?.startNativeVoice) throw new Error("Native voice недоступен (нужен Sloncord Desktop).");
      const res = await b.startNativeVoice({
        ...creds,
        udpHost: resolveNativeUdpHost(creds.udpHost),
        roomId: opts.roomId,
        userId: String(opts.selfUserId),
        muted,
        deafened,
      });
      if (!res.ok) throw new Error(res.error || "native_voice_start_failed");
      lastNativeUdpRefreshAt = Date.now();
    })();
    try {
      await nativeUdpRefreshInFlight;
    } finally {
      nativeUdpRefreshInFlight = null;
    }
  }

  function applyMuteDeafen() {
    try {
      localStorage.setItem("sloncord_voice_mic_enabled", muted ? "0" : "1");
      localStorage.setItem("sloncord_voice_deafened", deafened ? "1" : "0");
    } catch {
      /* ignore */
    }
    setState({ muted, deafened });
    void bridge()?.setNativeVoiceMuted?.(muted);
    void bridge()?.setNativeVoiceDeafened?.(deafened);
    sendPresence({
      type: "setUserFlags",
      roomId: opts.roomId,
      muted,
      deafened,
    });
  }

  function startSpeakingLoop() {
    stopSpeakingLoop();
    speakingTimer = setInterval(() => {
      if (destroyed) return;
      sendPresence({
        type: "setSpeaking",
        roomId: opts.roomId,
        speaking,
      });
    }, 900);
  }

  function stopSpeakingLoop() {
    if (speakingTimer) clearInterval(speakingTimer);
    speakingTimer = null;
  }

  function ensureRemoteHostImg(userId: string, url: string) {
    const host = opts.remoteVideoHost || document.querySelector(".remote-video-host");
    if (!host) return;
    const id = peerDomId(userId);
    let img = document.getElementById(id) as HTMLImageElement | null;
    if (!img) {
      img = document.createElement("img");
      img.id = id;
      img.dataset.nativeScreen = "1";
      img.alt = "";
      img.style.display = "none";
      host.appendChild(img);
    }
    img.src = url;
    screenUrlByUserId.set(userId, url);
  }

  function stopScreenShareInternal() {
    screenSharing = false;
    if (screenCaptureTimer) clearInterval(screenCaptureTimer);
    screenCaptureTimer = null;
    try {
      screenStream?.getTracks?.().forEach((t) => t.stop());
    } catch {
      /* ignore */
    }
    screenStream = null;
    screenVideoEl = null;
    screenCanvas = null;
    sendPresence({ type: "screenShare", roomId: opts.roomId, enabled: false });
  }

  async function startScreenShareInternal() {
    const b = bridge();
    const selection = b?.takeDisplaySelection ? await b.takeDisplaySelection() : null;
    const videoConstraints: MediaTrackConstraints = selection?.sourceId
      ? ({
          mandatory: {
            chromeMediaSource: "desktop",
            chromeMediaSourceId: selection.sourceId,
            maxWidth: 1280,
            maxHeight: 720,
            maxFrameRate: 12,
          },
        } as MediaTrackConstraints)
      : { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 12 } };

    const stream = await navigator.mediaDevices.getDisplayMedia({
      video: videoConstraints,
      audio: false,
    });
    screenStream = stream;
    screenSharing = true;
    screenVideoEl = document.createElement("video");
    screenVideoEl.muted = true;
    screenVideoEl.playsInline = true;
    screenVideoEl.srcObject = stream;
    await screenVideoEl.play().catch(() => {});
    screenCanvas = document.createElement("canvas");
    sendPresence({ type: "screenShare", roomId: opts.roomId, enabled: true });

    stream.getVideoTracks?.()?.[0]?.addEventListener?.("ended", () => {
      stopScreenShareInternal();
    });

    screenCaptureTimer = setInterval(() => {
      if (!screenSharing || !screenVideoEl || !screenCanvas || !b?.sendNativeVideoFrame) return;
      const vw = screenVideoEl.videoWidth || 1280;
      const vh = screenVideoEl.videoHeight || 720;
      if (vw < 2 || vh < 2) return;
      const scale = Math.min(1, 1280 / vw);
      const w = Math.max(2, Math.round(vw * scale));
      const h = Math.max(2, Math.round(vh * scale));
      screenCanvas.width = w;
      screenCanvas.height = h;
      const ctx = screenCanvas.getContext("2d");
      if (!ctx) return;
      ctx.drawImage(screenVideoEl, 0, 0, w, h);
      const dataUrl = screenCanvas.toDataURL("image/jpeg", 0.72);
      const b64 = dataUrl.split(",")[1] || "";
      if (b64) void b.sendNativeVideoFrame(b64);
    }, 120);
  }

  return {
    async join() {
      readPersistedMuteDeafen();
      voiceFsm.transition("joining", "join");
      setState({ joining: true, connected: false, room: opts.roomId, muted, deafened });

      unsubSpeaking = bridge()?.onNativeVoiceSpeaking?.((d) => {
        speaking = !!d.speaking;
      }) ?? null;
      unsubError = bridge()?.onNativeVoiceError?.((msg) => {
        if (destroyed) return;
        const text = String(msg || "native_error");
        voiceFsm.transition("degraded", text);
        opts.onNativeVoiceError?.(text);
      }) ?? null;
      unsubRemoteVideo =
        bridge()?.onNativeRemoteVideo?.(({ sessionId, jpegBase64 }) => {
          const uid = sessionToUserId.get(Number(sessionId));
          if (!uid || !jpegBase64) return;
          const url = `data:image/jpeg;base64,${jpegBase64}`;
          ensureRemoteHostImg(uid, url);
        }) ?? null;

      await presence.connect();
      presence.startPing();
      await refreshNativeUdp();
      await rebuildSessionMap();
      applyMuteDeafen();
      startSpeakingLoop();

      voiceFsm.transition("connected", "join-ok");
      setState({
        joining: false,
        connected: true,
        mediaLinkReady: true,
        room: opts.roomId,
        peers: Math.max(0, lastRoster.length - 1),
      });
    },

    toggleMute() {
      muted = !muted;
      if (muted) speaking = false;
      applyMuteDeafen();
    },

    toggleDeafen() {
      deafened = !deafened;
      if (deafened) muted = true;
      else muted = false;
      applyMuteDeafen();
    },

    async toggleScreenShare() {
      if (screenSharing) {
        stopScreenShareInternal();
        return;
      }
      try {
        await startScreenShareInternal();
      } catch (e) {
        const msg = (e && typeof e === "object" && "message" in e && (e as Error).message) || String(e);
        opts.onScreenAudioError?.(msg);
        throw e;
      }
    },

    async reconfigureScreenShare() {
      if (!screenSharing) return;
      stopScreenShareInternal();
      await startScreenShareInternal();
    },

    isNativeScreenMode() {
      return true;
    },

    getNativeScreenUrl(peerId: string) {
      return screenUrlByUserId.get(String(peerId)) || "";
    },

    ensurePlayback() {
      /* native */
    },

    ensurePeerFor(uid: string) {
      const url = screenUrlByUserId.get(String(uid));
      if (url) ensureRemoteHostImg(String(uid), url);
    },

    renegotiateAll() {
      /* no-op */
    },

    setScreenAudioVolume(_pid: string, _pct: number) {
      /* screen audio via native helper — later */
    },

    getInputMeter() {
      return { level: speaking ? 0.6 : 0.05, speaking };
    },

    setInputDevice(deviceId: string) {
      void bridge()?.setNativeVoiceInputDevice?.(String(deviceId || ""));
      return Promise.resolve();
    },

    setOutputDevice(deviceId: string) {
      void bridge()?.setNativeVoiceOutputDevice?.(String(deviceId || ""));
      return Promise.resolve();
    },

    setMicGain(_gain: number) {
      /* future */
    },

    setSpeakerGain(_gain: number) {
      /* future */
    },

    setAudioProcessing(_opts: unknown) {
      /* native */
    },

    destroy() {
      destroyed = true;
      stopScreenShareInternal();
      stopSpeakingLoop();
      try {
        sendPresence({ type: "setSpeaking", roomId: opts.roomId, speaking: false });
      } catch {
        /* ignore */
      }
      presence.stopPing();
      presence.close();
      unsubSpeaking?.();
      unsubError?.();
      unsubRemoteVideo?.();
      void bridge()?.stopNativeVoice?.();
      unsubSpeaking = null;
      unsubError = null;
      unsubRemoteVideo = null;
      screenUrlByUserId.clear();
      voiceFsm.transition("idle", "destroy");
      setState({
        connected: false,
        joining: false,
        mediaLinkReady: false,
        room: "",
        peers: 0,
        remotePeerUserIds: [],
        rosterUserIds: [],
      });
    },
  };
}
