import { getApiBase } from "../config/apiBase";
import { createNativePresenceClient } from "./nativePresenceClient";
import { deriveNativeSessionId } from "./nativeSessionId";
import { applyDisplayCaptureProfileToTrack } from "./screenShare";
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
  setNativeVoiceProcessing?: (opts: Record<string, unknown>) => Promise<{ ok: boolean }>;
  setNativeVoiceMicGain?: (gain: number) => Promise<{ ok: boolean }>;
  setNativeVoiceSpeakerGain?: (gain: number) => Promise<{ ok: boolean }>;
  setNativeVoiceWatchScreen?: (sessionId: number) => Promise<{ ok: boolean }>;
  playNativeScreenPcm?: (pcmBase64: string, gain: number) => Promise<{ ok: boolean }>;
  onNativeScreenAudio?: (cb: (chunk: ArrayBuffer) => void) => () => void;
  sendNativeVideoFrame?: (jpegBase64: string) => Promise<{ ok: boolean }>;
  onNativeVoiceSpeaking?: (cb: (detail: { speaking: boolean; level: number; threshold?: number }) => void) => () => void;
  onNativeRemoteVideo?: (cb: (detail: { sessionId: number; jpegBase64: string }) => void) => () => void;
  onNativeVoiceError?: (cb: (msg: string) => void) => () => void;
  takeDisplaySelection?: () => Promise<{ tab: "screen" | "window"; sourceId: string; withSystemAudio: boolean } | null>;
  takeDisplayCaptureProfile?: () => Promise<{ maxHeight: number; frameRate: number } | null>;
  setDisplayCaptureLive?: (live: boolean) => Promise<{ ok: boolean }>;
  startNativeScreenAudio?: (
    selection?: { tab: "screen" | "window"; sourceId: string; withSystemAudio: boolean } | null
  ) => Promise<{ ok: boolean; error?: string }>;
  stopNativeScreenAudio?: () => Promise<{ ok: boolean }>;
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
  let meter = { rms: 0, threshold: 0.03, open: false };
  let screenHeartbeat: ReturnType<typeof setInterval> | null = null;
  let lastRoster: string[] = [];
  let speakingTimer: ReturnType<typeof setInterval> | null = null;
  let unsubSpeaking: (() => void) | null = null;
  let unsubError: (() => void) | null = null;
  let unsubRemoteVideo: (() => void) | null = null;
  let unsubScreenPcm: (() => void) | null = null;
  let lastNativeUdpRefreshAt = 0;
  let nativeUdpRefreshInFlight: Promise<void> | null = null;
  let screenSharing = false;
  const serverSessionByUser = new Map<string, number>();
  let watchedScreenUserId = "";
  let screenListenGain = 1;
  let screenPcmPending: Uint8Array[] = [];
  let screenPcmPendingBytes = 0;
  const screenAudioStats = { captured: 0, peak: 0, sent: 0, received: 0, played: 0, skipped: 0 };
  let screenStream: MediaStream | null = null;
  let screenCaptureTimer: ReturnType<typeof setInterval> | null = null;
  let screenVideoEl: HTMLVideoElement | null = null;
  let screenCanvas: HTMLCanvasElement | null = null;
  const screenUrlByUserId = new Map<string, string>();
  const sessionToUserId = new Map<number, string>();
  const pendingJpegBySession = new Map<number, string>();
  let rosterKey = "";
  let mapGen = 0;

  const voiceFsm = createVoiceSessionState();

  function setState(patch: Record<string, unknown>) {
    opts.onState(patch);
  }

  function showRemoteFrame(userId: string, jpegBase64: string) {
    const url = `data:image/jpeg;base64,${jpegBase64}`;
    ensureRemoteHostImg(userId, url);
  }

  function flushPendingFrames() {
    for (const [sid, jpeg] of pendingJpegBySession) {
      const uid = sessionToUserId.get(sid);
      if (!uid) continue;
      pendingJpegBySession.delete(sid);
      showRemoteFrame(uid, jpeg);
    }
  }

  async function rebuildSessionMap() {
    const ids = lastRoster.filter(Boolean);
    const key = ids.join(",");
    if (key === rosterKey && sessionToUserId.size > 0) return;
    rosterKey = key;
    const gen = ++mapGen;
    const next = new Map<number, string>();
    for (const uid of ids) {
      if (!uid || uid === String(opts.selfUserId)) continue;
      const fromServer = serverSessionByUser.get(String(uid).toLowerCase());
      if (fromServer && fromServer > 0) {
        next.set(fromServer, uid);
        continue;
      }
      try {
        next.set(await deriveNativeSessionId(uid, opts.roomId), uid);
      } catch {
        /* ignore */
      }
    }
    try {
      const selfId = String(opts.selfUserId);
      const fromServer = serverSessionByUser.get(selfId.toLowerCase());
      next.set(
        fromServer && fromServer > 0 ? fromServer : await deriveNativeSessionId(selfId, opts.roomId),
        selfId
      );
    } catch {
      /* ignore */
    }
    if (gen !== mapGen) return;
    sessionToUserId.clear();
    for (const [sid, uid] of next) sessionToUserId.set(sid, uid);
    flushPendingFrames();
  }

  function sameVoiceUser(a: string, b: string) {
    const na = String(a || "").replace(/-/g, "").toLowerCase();
    const nb = String(b || "").replace(/-/g, "").toLowerCase();
    return na.length > 0 && na === nb;
  }

  function bytesToBase64(bytes: Uint8Array): string {
    let binary = "";
    const step = 8192;
    for (let i = 0; i < bytes.length; i += step) {
      binary += String.fromCharCode(...bytes.subarray(i, Math.min(i + step, bytes.length)));
    }
    return btoa(binary);
  }

  function flushScreenPcm() {
    if (screenPcmPendingBytes <= 0) return;
    const all = new Uint8Array(screenPcmPendingBytes);
    let off = 0;
    for (const c of screenPcmPending) {
      all.set(c, off);
      off += c.byteLength;
    }
    screenPcmPending = [];
    screenPcmPendingBytes = 0;
    if (destroyed || !screenSharing) return;
    const b64 = bytesToBase64(all);
    if (!b64 || b64.length > 100_000) return;
    screenAudioStats.sent += 1;
    sendPresence({ type: "screenAudio", roomId: opts.roomId, payload: b64 });
  }

  async function setWatchScreen(userId: string) {
    const id = String(userId || "");
    watchedScreenUserId = id;
    // Любой ненулевой id включает звук демонстрации. Сравнение session id
    // раньше глушило дорожку, даже когда кадры уже шли.
    void bridge()?.setNativeVoiceWatchScreen?.(id ? 1 : 0);
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
      applyMuteDeafen();
      if (screenSharing) publishScreenFlag(true);
      const now = Date.now();
      if (now - lastNativeUdpRefreshAt < 4000) return;
      void refreshNativeUdp().catch(() => {});
    },
    onScreenFrame: (userId, jpegBase64) => {
      if (!userId || !jpegBase64) return;
      showRemoteFrame(String(userId), String(jpegBase64));
    },
    onScreenAudio: (userId, pcmBase64) => {
      screenAudioStats.received += 1;
      if (!pcmBase64 || !watchedScreenUserId || screenListenGain <= 0 || !sameVoiceUser(userId, watchedScreenUserId)) {
        screenAudioStats.skipped += 1;
        return;
      }
      screenAudioStats.played += 1;
      void bridge()?.playNativeScreenPcm?.(pcmBase64, screenListenGain);
    },
    onRoomRoster: (msg) => {
      const ids = Array.isArray(msg.userIds) ? msg.userIds.map((x) => String(x)) : [];
      const rawSessions = msg.nativeSessionByUserId;
      if (rawSessions && typeof rawSessions === "object") {
        serverSessionByUser.clear();
        for (const [k, v] of Object.entries(rawSessions as Record<string, unknown>)) {
          const n = Number(v);
          if (Number.isFinite(n) && n > 0) serverSessionByUser.set(String(k).toLowerCase(), n);
        }
      }
      lastRoster = ids;
      void rebuildSessionMap();
      const patch: Record<string, unknown> = {
        rosterUserIds: ids,
        remotePeerUserIds: ids.filter((id) => id && id !== String(opts.selfUserId)),
        peers: Math.max(0, ids.length - 1),
        speakingUserIds: Array.isArray(msg.speakingUserIds) ? msg.speakingUserIds.map(String) : [],
        mutedUserIds: Array.isArray(msg.mutedUserIds) ? msg.mutedUserIds.map(String) : [],
        deafenedUserIds: Array.isArray(msg.deafenedUserIds) ? msg.deafenedUserIds.map(String) : [],
      };
      if (Array.isArray(msg.screenShareUserIds)) {
        patch.screenShareUserIds = msg.screenShareUserIds.map(String);
      }
      setState(patch);
      if (watchedScreenUserId) void setWatchScreen(watchedScreenUserId);
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
      if (!res.ok) {
        if (destroyed || res.error === "cancelled") throw new Error("destroyed");
        throw new Error(res.error || "native_voice_start_failed");
      }
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
    let statTick = 0;
    speakingTimer = setInterval(() => {
      if (destroyed) return;
      sendPresence({
        type: "setSpeaking",
        roomId: opts.roomId,
        speaking,
      });
      statTick += 1;
      if (statTick % 6 !== 0) return;
      const s = screenAudioStats;
      if (s.captured + s.sent + s.received + s.played + s.skipped === 0 && !screenSharing && !watchedScreenUserId) return;
      sendPresence({
        type: "screenAudioStat",
        roomId: opts.roomId,
        payload: `captured=${s.captured} peak=${s.peak} sent=${s.sent} received=${s.received} played=${s.played} skipped=${s.skipped} sharing=${screenSharing ? 1 : 0} watch=${watchedScreenUserId || "-"} gain=${screenListenGain}`,
      });
      s.captured = 0;
      s.peak = 0;
      s.sent = 0;
      s.received = 0;
      s.played = 0;
      s.skipped = 0;
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

  function publishScreenFlag(enabled: boolean) {
    setState({ sharingScreen: enabled });
    sendPresence({ type: "screenShare", roomId: opts.roomId, enabled });
    if (screenHeartbeat) clearInterval(screenHeartbeat);
    screenHeartbeat = null;
    if (!enabled) return;
    screenHeartbeat = setInterval(() => {
      if (destroyed || !screenSharing) return;
      sendPresence({ type: "screenShare", roomId: opts.roomId, enabled: true });
    }, 4000);
  }

  async function stopScreenShareInternal() {
    const wasSharing = screenSharing;
    screenSharing = false;
    screenPcmPending = [];
    screenPcmPendingBytes = 0;
    try {
      void bridge()?.stopNativeScreenAudio?.();
    } catch {
      /* ignore */
    }
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
    if (wasSharing) publishScreenFlag(false);
    try {
      await bridge()?.setDisplayCaptureLive?.(false);
    } catch {
      /* ignore */
    }
  }

  async function startScreenShareInternal() {
    const b = bridge();
    // Источник выбирает Electron в setDisplayMediaRequestHandler.
    // chromeMediaSource/mandatory в getDisplayMedia даёт "exact constraints are not supported".
    // audio:false — иначе Chromium снова вызывает выбор источника, потому что
    // обработчик отдаёт только видео. Галочка системного звука живёт в нашем окне.
    const stream = await navigator.mediaDevices.getDisplayMedia({
      video: true,
      audio: false,
    });
    const videoTrack = stream.getVideoTracks?.()?.[0];
    if (!videoTrack) {
      try { stream.getTracks?.().forEach((t) => t.stop()); } catch { /* ignore */ }
      throw new Error("Не удалось начать демонстрацию экрана.");
    }
    videoTrack.addEventListener("ended", () => {
      void stopScreenShareInternal();
    });
    let selection: { tab: "screen" | "window"; sourceId: string; withSystemAudio: boolean } | null = null;
    try {
      selection = (await b?.takeDisplaySelection?.()) ?? null;
    } catch {
      selection = null;
    }
    if (videoTrack.readyState !== "live") {
      try { stream.getTracks?.().forEach((t) => t.stop()); } catch { /* ignore */ }
      throw new Error("Не удалось начать демонстрацию экрана.");
    }
    screenStream = stream;
    screenSharing = true;
    let capProfile: { maxHeight: number; frameRate: number } | null = null;
    try {
      capProfile = (await b?.takeDisplayCaptureProfile?.()) ?? null;
    } catch {
      capProfile = null;
    }
    const maxHeight = Math.max(360, Math.min(1440, Number(capProfile?.maxHeight) || 720));
    const fps = Math.max(5, Math.min(60, Number(capProfile?.frameRate) || 30));
    try {
      await applyDisplayCaptureProfileToTrack(videoTrack, {
        maxWidth: Math.round(maxHeight * 16 / 9),
        maxHeight,
        frameRate: fps,
      });
    } catch {
      /* ignore */
    }
    screenVideoEl = document.createElement("video");
    screenVideoEl.muted = true;
    screenVideoEl.playsInline = true;
    screenVideoEl.srcObject = stream;
    await screenVideoEl.play().catch(() => {});
    screenCanvas = document.createElement("canvas");
    publishScreenFlag(true);
    if (selection?.withSystemAudio) {
      void b?.startNativeScreenAudio?.(selection).then((audioRes) => {
        if (audioRes && !audioRes.ok) {
          opts.onScreenAudioError?.(
            audioRes.error || "Системный звук демонстрации не запустился. Видео идёт без звука."
          );
        }
      }).catch(() => {});
    }

    const frameMs = Math.max(16, Math.round(1000 / fps));
    const byteBudget = maxHeight >= 1440 ? 520000 : maxHeight >= 1080 ? 380000 : maxHeight >= 720 ? 240000 : 140000;
    let frameBusy = false;
    let jpegQuality = maxHeight >= 1440 ? 0.52 : maxHeight >= 1080 ? 0.6 : 0.72;
    screenCaptureTimer = setInterval(() => {
      if (frameBusy || !screenSharing || !screenVideoEl || !screenCanvas) return;
      const track = screenStream?.getVideoTracks?.()?.[0];
      if (!track || track.readyState !== "live") {
        void stopScreenShareInternal();
        return;
      }
      const vw = screenVideoEl.videoWidth;
      const vh = screenVideoEl.videoHeight;
      if (vw < 2 || vh < 2) return;
      const scale = vh > maxHeight ? maxHeight / vh : 1;
      const w = Math.max(2, Math.round(vw * scale));
      const h = Math.max(2, Math.round(vh * scale));
      if (screenCanvas.width !== w) screenCanvas.width = w;
      if (screenCanvas.height !== h) screenCanvas.height = h;
      const ctx = screenCanvas.getContext("2d", { alpha: false });
      if (!ctx) return;
      ctx.imageSmoothingEnabled = scale < 0.999;
      ctx.imageSmoothingQuality = "high";
      ctx.drawImage(screenVideoEl, 0, 0, w, h);
      let dataUrl = screenCanvas.toDataURL("image/jpeg", jpegQuality);
      let b64 = dataUrl.split(",")[1] || "";
      if (b64.length > byteBudget && jpegQuality > 0.42) {
        jpegQuality = Math.max(0.42, jpegQuality - 0.06);
        dataUrl = screenCanvas.toDataURL("image/jpeg", jpegQuality);
        b64 = dataUrl.split(",")[1] || "";
      }
      if (!b64 || b64.length > 600000) return;
      frameBusy = true;
      sendPresence({ type: "screenFrame", roomId: opts.roomId, payload: b64 });
      frameBusy = false;
    }, frameMs);
  }

  return {
    async join() {
      readPersistedMuteDeafen();
      voiceFsm.transition("joining", "join");
      setState({ joining: true, connected: false, room: opts.roomId, muted, deafened });

      unsubSpeaking = bridge()?.onNativeVoiceSpeaking?.((d) => {
        speaking = !!d.speaking;
        meter = {
          rms: Number(d.level) || 0,
          threshold: Number(d.threshold) || 0.03,
          open: !!d.speaking,
        };
      }) ?? null;
      unsubError = bridge()?.onNativeVoiceError?.((msg) => {
        if (destroyed) return;
        const text = String(msg || "native_error");
        voiceFsm.transition("degraded", text);
        opts.onNativeVoiceError?.(text);
      }) ?? null;
      unsubRemoteVideo =
        bridge()?.onNativeRemoteVideo?.(({ sessionId, jpegBase64 }) => {
          if (!jpegBase64) return;
          const sid = Number(sessionId);
          const uid = sessionToUserId.get(sid);
          if (!uid) {
            pendingJpegBySession.set(sid, jpegBase64);
            return;
          }
          showRemoteFrame(uid, jpegBase64);
        }) ?? null;
      unsubScreenPcm =
        bridge()?.onNativeScreenAudio?.((ab) => {
          if (destroyed || !screenSharing || !ab || ab.byteLength < 4 || ab.byteLength > 256 * 1024) return;
          // Helper отдаёт по 10 мс; копим ~40 мс, чтобы не слать 100 сообщений в секунду.
          const chunk = new Uint8Array(ab);
          const view = new DataView(ab);
          for (let i = 0; i + 1 < chunk.byteLength; i += 16) {
            const v = Math.abs(view.getInt16(i, true));
            if (v > screenAudioStats.peak) screenAudioStats.peak = v;
          }
          screenAudioStats.captured += 1;
          if (screenPcmPendingBytes + chunk.byteLength > 64 * 1024) flushScreenPcm();
          screenPcmPending.push(chunk);
          screenPcmPendingBytes += chunk.byteLength;
          if (screenPcmPendingBytes >= 7680) flushScreenPcm();
        }) ?? null;

      await presence.connect();
      if (destroyed) throw new Error("destroyed");
      presence.startPing();
      await refreshNativeUdp();
      if (destroyed) throw new Error("destroyed");
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
        await stopScreenShareInternal();
        return;
      }
      try {
        await startScreenShareInternal();
      } catch (e) {
        await stopScreenShareInternal();
        const msg = (e && typeof e === "object" && "message" in e && (e as Error).message) || String(e);
        opts.onScreenAudioError?.(msg);
        throw e;
      }
    },

    async reconfigureScreenShare() {
      if (!screenSharing) return;
      await stopScreenShareInternal();
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

    setScreenAudioVolume(pid: string, pct: number) {
      const v = Math.max(0, Math.min(300, Number(pct) || 0));
      if (v <= 0) {
        watchedScreenUserId = "";
        screenListenGain = 0;
        return;
      }
      watchedScreenUserId = String(pid || "");
      screenListenGain = Math.min(3, v / 100);
    },

    setWatchScreen,

    getInputMeter() {
      return meter;
    },

    setInputDevice(deviceId: string) {
      void bridge()?.setNativeVoiceInputDevice?.(String(deviceId || ""));
      return Promise.resolve();
    },

    setOutputDevice(deviceId: string) {
      void bridge()?.setNativeVoiceOutputDevice?.(String(deviceId || ""));
      return Promise.resolve();
    },

    setMicGain(gain: number) {
      void bridge()?.setNativeVoiceMicGain?.(Number(gain) || 0);
    },

    setSpeakerGain(gain: number) {
      void bridge()?.setNativeVoiceSpeakerGain?.(Number(gain) || 0);
    },

    setAudioProcessing(opts: Record<string, unknown>) {
      void bridge()?.setNativeVoiceProcessing?.(opts || {});
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
      unsubScreenPcm?.();
      void bridge()?.stopNativeVoice?.();
      unsubSpeaking = null;
      unsubError = null;
      unsubRemoteVideo = null;
      unsubScreenPcm = null;
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
