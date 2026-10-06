import { getLastNativeScreenAudioStartError, getNativeScreenCapturePort, isNativeScreenAudioActive, startNativeScreenAudioTrack, stopNativeScreenAudioTrack } from "../audio/nativeScreenAudioTrack";
import { ScreenAudioVoiceRef } from "../audio/screenAudioVoiceRef";
import { loadMediasoupClient } from "./mediasoupLoader";
import { createPresenceClient, type PresenceClientApi } from "./presenceClient";
import { createMediasoupTransports, createSfuRequester } from "./sfuMediaClient";
import {
  applyDisplayCaptureProfileToTrack,
  bitrateForScreenShareProfile,
  buildScreenAudioConstraints,
  screenVolumePctToGain,
  type DisplayCaptureProfile,
} from "./screenShare";
import { normalizeIceServers, type IceServerEntry } from "./turnConfig";
import { createVoiceSessionState } from "./voiceSessionState";

export function createSfuVoiceSession({
  token,
  roomId,
  selfUserId,
  remoteAudioHost,
  remoteVideoHost,
  onState,
  sfuUrl: initialSfuUrl,
  sfuToken: initialSfuToken,
  useVoiceGateway: initialUseVoiceGateway = false,
  iceServers: initialIceServers = null,
  tokenTtlSeconds: initialTokenTtlSeconds = 43200,
  refreshSfuCredentials,
  onCloseScreenViewForPeer,
  onRefreshScreenViewForPeer,
  onDetachScreenViewForPeer,
  onScreenAudioError,
  onForceLeave,
  onVoiceMove
}) {
  let destroyed = false;
  /** Единый voice gateway: SFU-сигналинг через `/ws/voice`, без прямого WS к SFU. */
  let useVoiceGateway = !!initialUseVoiceGateway;
  /** JWT с `/voice/sfuToken` истекает (по умолчанию ~10 мин); при пересоздании WS нужен новый токен. */
  let liveSfuUrl = String(initialSfuUrl || "");
  let liveSfuToken = String(initialSfuToken || "");
  let sfuPendingRebuildRetryTimer = null;
  const reconnectPreserve = { screen: false, camera: false };
  const screenShareState = { fps: 30, maxBitrate: 6_000_000 };
  let screenAudioCaptureTrack = null;
  let screenVoiceEchoRef = null;
  let networkRecoveryHandlers = null;
  let credentialRefreshTimer: ReturnType<typeof setInterval> | null = null;
  let liveTokenTtlSeconds = Math.max(120, Number(initialTokenTtlSeconds) || 43200);
  const iceServersList: IceServerEntry[] = normalizeIceServers(initialIceServers);
  const voiceFsm = createVoiceSessionState();
  let presenceClient: PresenceClientApi | null = null;
  let mediaRebuildFn: ((reason: string, isRetry?: boolean, skipGateway?: boolean) => Promise<void>) | null = null;

  const reportScreenAudioError =
    typeof onScreenAudioError === "function"
      ? (msg: string) => {
          try {
            onScreenAudioError(String(msg || ""));
          } catch {
            /* ignore */
          }
        }
      : () => {};

  const closeViewerForPeer =
    typeof onCloseScreenViewForPeer === "function"
      ? (uid) => {
          try {
            onCloseScreenViewForPeer(String(uid));
          } catch {
            /* ignore */
          }
        }
      : () => {};

  const refreshScreenViewForPeer =
    typeof onRefreshScreenViewForPeer === "function"
      ? (uid) => {
          try {
            onRefreshScreenViewForPeer(String(uid));
          } catch {
            /* ignore */
          }
        }
      : () => {};

  const detachScreenViewForPeer =
    typeof onDetachScreenViewForPeer === "function"
      ? (uid) => {
          try {
            onDetachScreenViewForPeer(String(uid));
          } catch {
            /* ignore */
          }
        }
      : () => {};

  function isSfuSignalingOpen() {
    if (useVoiceGateway) {
      return !!(presenceClient?.getSocket()?.readyState === WebSocket.OPEN && presenceClient?.isGatewayReady());
    }
    return !!(sfuWs && sfuWs.readyState === WebSocket.OPEN);
  }

  async function applyFreshSfuCredentials(skipGatewayReconnect = false) {
    if (destroyed) return;
    if (useVoiceGateway) {
      if (!skipGatewayReconnect && presenceClient) {
        presenceClient.setGatewayReady(false);
        voiceFsm.transition("recovering", "gateway-credential-refresh");
        try {
          await presenceClient.requestGatewayReconnect();
          voiceFsm.transition("connected", "gateway-credential-refresh-ok");
        } catch {
          voiceFsm.markRecoveryFailed("gateway-credential-refresh");
        }
      }
      return;
    }
    if (typeof refreshSfuCredentials !== "function") return;
    try {
      const c = await refreshSfuCredentials();
      const u = String(c?.sfuUrl ?? "").trim();
      const t = String(c?.sfuToken ?? "").trim();
      if (u) liveSfuUrl = u;
      if (t) liveSfuToken = t;
      const ttl = Number(c?.tokenTtlSeconds);
      if (Number.isFinite(ttl) && ttl > 0) {
        liveTokenTtlSeconds = ttl;
        startCredentialRefreshTimer();
      }
    } catch {
      /* ignore */
    }
  }

  function clearSfuRebuildRetryTimer() {
    if (sfuPendingRebuildRetryTimer) {
      try { clearTimeout(sfuPendingRebuildRetryTimer); } catch { /* ignore */ }
      sfuPendingRebuildRetryTimer = null;
    }
  }

  const LS_MIC = "sloncord_voice_mic_enabled";
  const LS_DEAF = "sloncord_voice_deafened";
  /** Opus/SFU — 48 kHz; единый rate снижает артефакты ресэмплинга в длинных звонках. */
  const VOICE_SAMPLE_RATE = 48000;
  let micEnabledWanted = true;
  let deafened = false;
  try {
    const v = localStorage.getItem(LS_MIC);
    if (v === "0") micEnabledWanted = false;
    if (v === "1") micEnabledWanted = true;
  } catch { /* ignore */ }
  try {
    deafened = (localStorage.getItem(LS_DEAF) || "0") === "1";
  } catch { deafened = false; }
  let lastRoster = [];

  // SFU media.
  let sfuWs = null;
  let device = null;
  let sendTransport = null;
  let recvTransport = null;
  let localMicStream = null;
  let camStream = null;
  let screenStream = null;
  let micProducer = null;
  let camProducer = null;
  let screenProducer = null;
  let screenAudioProducer = null;
  let lastSharers = [];
  const consumers = new Map(); // consumerId -> consumer
  const producerMetaById = new Map(); // producerId -> { userId, source }
  const consumedProducerIds = new Set(); // producerId -> consumed
  const pendingScreenEndTimers = new Map(); // userId -> timeout id
  let audioCtx = null;
  /** Отдельный контекст для boost >100% входящего звука — общий с микрофоном ломает эфир при 2+ пайпах. */
  let playbackAudioCtx = null;
  let playbackLimiterNode = null;
  let speakingTimer = null;
  const speakingAnalysers = new Map(); // userId -> { analyser, streamKey, src }
  /** Speaking indicators relayed from voice gateway roster (other participants). */
  let rosterSpeakingFromServer = new Set();
  /** uid -> ms; server roster speaking TTL (~1.5s), локально не держим «вечно». */
  const rosterSpeakingExpiryMs = new Map();
  /** Клоны треков только для анализатора ростера (один на uid, не каждый тик). */
  const rosterMeterCloneByUid = new Map();
  const rmsScratchByFft = new Map();
  let resyncRemoteProducersInFlight = false;
  let resyncRemoteProducersQueued = false;
  let audioCtxUnlockHandler: (() => void) | null = null;

  function getRmsScratch(fftSize: number) {
    const n = Math.max(32, Number(fftSize) || 1024);
    let buf = rmsScratchByFft.get(n);
    if (!buf || buf.length !== n) {
      buf = new Uint8Array(n);
      rmsScratchByFft.set(n, buf);
    }
    return buf;
  }

  function releaseRosterMeterClone(uid) {
    const prev = rosterMeterCloneByUid.get(String(uid));
    if (!prev) return;
    try { prev.cloneTrack?.stop?.(); } catch { /* ignore */ }
    rosterMeterCloneByUid.delete(String(uid));
  }

  function releaseAllRosterMeterClones() {
    for (const uid of Array.from(rosterMeterCloneByUid.keys())) releaseRosterMeterClone(uid);
  }

  function getCachedMeterStream(uid, sourceTrack) {
    if (!sourceTrack || sourceTrack.readyState === "ended") return null;
    const id = String(uid);
    const tid = String(sourceTrack.id || "");
    const prev = rosterMeterCloneByUid.get(id);
    if (prev?.trackId === tid && prev.stream) return prev.stream;
    releaseRosterMeterClone(id);
    try {
      if (typeof sourceTrack.clone !== "function") return null;
      const cloneTrack = sourceTrack.clone();
      const stream = new MediaStream([cloneTrack]);
      rosterMeterCloneByUid.set(id, { trackId: tid, cloneTrack, stream });
      return stream;
    } catch {
      return null;
    }
  }

  const audioElByUserId = new Map(); // key(userId:source) -> HTMLAudioElement
  const audioPipeByKey = new Map(); // `${userId}:${source}` -> { gainNode, srcNode, destNode, originalStream }
  const userVolumePctByUserId = new Map(); // userId -> 0..300 (runtime cache)
  const directStreamByKey = new Map(); // `${userId}:${source}` -> MediaStream
  const screenAudioPctByUserId = new Map(); // userId -> 0..300 (local-only, for screenAudio)
  let gestureHandler = null;
  let playbackHealTimer = null;
  let sfuVisibilityHandler = null;
  let recvTransportRecoveryTimer = null;
  let sfuWsPingTimer = null;
  let lastSfuPongAt = 0;
  let sfuMediaRebuildInFlight = false;
  let sfuPendingRebuildReason = null;
  let sfuPendingRebuildSkipGateway = false;
  let connectionChangeDebounce = null;
  let audioCtxKeepAliveTimer = null;
  let playbackHealTick = 0;
  let healNoAudioStreak = 0;
  const consumeInFlight = new Set();

  function createVoiceAudioContext() {
    const Ctor = window.AudioContext || window.webkitAudioContext;
    if (!Ctor) return null;
    try {
      return new Ctor({ sampleRate: VOICE_SAMPLE_RATE });
    } catch {
      try {
        return new Ctor();
      } catch {
        return null;
      }
    }
  }

  function ensurePlaybackLimiter(ctx) {
    if (!ctx || ctx.state === "closed") return ctx?.destination || null;
    if (!playbackLimiterNode || playbackLimiterNode.context !== ctx) {
      playbackLimiterNode = ctx.createDynamicsCompressor();
      playbackLimiterNode.threshold.value = -14;
      playbackLimiterNode.knee.value = 6;
      playbackLimiterNode.ratio.value = 10;
      playbackLimiterNode.attack.value = 0.003;
      playbackLimiterNode.release.value = 0.12;
      playbackLimiterNode.connect(ctx.destination);
    }
    return playbackLimiterNode;
  }

  function pipeKey(uid, src) {
    return `${String(uid || "")}:${String(src || "mic")}`;
  }

  function audioDomId(peerId, source) {
    const pid = String(peerId).replace(/[^a-f0-9-]/gi, "x");
    const src = String(source || "mic").replace(/[^a-z0-9_-]/gi, "x");
    return `sfu-remote-audio-${pid}:${src}`;
  }

  function resolvePlaybackElement(uid, src) {
    const srcNorm = String(src || "mic");
    const pk = pipeKey(uid, srcNorm);
    let el = audioElByUserId.get(pk);
    if (el) return { el, pk, uid: String(uid), src: srcNorm };

    const want = String(uid || "").toLowerCase();
    for (const [k, e] of audioElByUserId.entries()) {
      const colon = k.indexOf(":");
      if (colon < 0) continue;
      const u = k.slice(0, colon);
      const s = k.slice(colon + 1);
      if (s !== srcNorm) continue;
      if (String(u).toLowerCase() === want) {
        audioElByUserId.set(pk, e);
        return { el: e, pk, uid: u, src: s };
      }
    }

    const dom = document.getElementById(audioDomId(uid, srcNorm));
    if (dom instanceof HTMLAudioElement) {
      audioElByUserId.set(pk, dom);
      return { el: dom, pk, uid: String(uid), src: srcNorm };
    }

    for (const c of consumers.values()) {
      if (!c || c.closed || c.kind !== "audio") continue;
      const pid = String(c.producerId || "");
      const meta = producerMetaById.get(pid) || {};
      const srcKind = String(meta.source || c.appData?.source || "mic");
      if (srcKind !== srcNorm) continue;
      const remoteUid = String(meta.userId || c.appData?.remoteUserId || "");
      if (remoteUid.toLowerCase() !== want) continue;
      const realPk = pipeKey(remoteUid, srcKind);
      const mapped = audioElByUserId.get(realPk);
      if (mapped) return { el: mapped, pk: realPk, uid: remoteUid, src: srcKind };
      const dom2 = document.getElementById(audioDomId(remoteUid, srcKind));
      if (dom2 instanceof HTMLAudioElement) {
        audioElByUserId.set(realPk, dom2);
        return { el: dom2, pk: realPk, uid: remoteUid, src: srcKind };
      }
    }

    return null;
  }

  function listMicPlaybackTargets(uid) {
    const want = String(uid || "").toLowerCase();
    const out = new Map();
    for (const [k] of audioElByUserId.entries()) {
      const colon = k.indexOf(":");
      if (colon < 0) continue;
      const u = k.slice(0, colon);
      const s = k.slice(colon + 1);
      if (s !== "mic") continue;
      if (String(u).toLowerCase() === want) out.set(k, { uid: u, src: s });
    }
    const resolved = resolvePlaybackElement(uid, "mic");
    if (resolved) out.set(resolved.pk, { uid: resolved.uid, src: resolved.src });
    return out;
  }

  function ensurePlaybackAudioCtx() {
    if (!window.AudioContext && !window.webkitAudioContext) return null;
    if (!playbackAudioCtx || playbackAudioCtx.state === "closed") {
      playbackAudioCtx = createVoiceAudioContext();
      playbackLimiterNode = null;
      if (!playbackAudioCtx) return null;
    }
    try { playbackAudioCtx.resume?.().catch(() => {}); } catch { /* ignore */ }
    return playbackAudioCtx.state === "closed" ? null : playbackAudioCtx;
  }

  function stopBoostTrack(pipe) {
    try { pipe?.boostTrack?.stop?.(); } catch { /* ignore */ }
    if (pipe) pipe.boostTrack = null;
  }

  /** После изменения playback-графа микрофонный контекст иногда засыпает — поднимаем эфир. */
  function stabilizeMicAfterPlaybackGraphChange() {
    try { audioCtx?.resume?.().catch(() => {}); } catch { /* ignore */ }
    try { ensureMicTransmitGain(); } catch { /* ignore */ }
  }

  function teardownUserPipe(uid, src) {
    const key = pipeKey(uid, src);
    const pipe = audioPipeByKey.get(key);
    if (!pipe) return;
    stopBoostTrack(pipe);
    try { pipe.srcNode?.disconnect?.(); } catch { /* ignore */ }
    try { pipe.mediaElementSource?.disconnect?.(); } catch { /* ignore */ }
    try { pipe.gainNode?.disconnect?.(); } catch { /* ignore */ }
    try { pipe.rosterAnalyser?.disconnect?.(); } catch { /* ignore */ }
    audioPipeByKey.delete(key);
    const el = audioElByUserId.get(key);
    const direct = directStreamByKey.get(key);
    if (el && direct) {
      try { el.srcObject = direct; } catch { /* ignore */ }
    }
  }

  function tryPlayAllRemoteMedia() {
    try {
      audioElByUserId.forEach((el, mapKey) => {
        try {
          if (!el) return;
          el.muted = !!deafened;
          if (!deafened && el.muted) el.muted = false;
          try {
            const idx = String(mapKey).indexOf(":");
            const uid = idx >= 0 ? String(mapKey).slice(0, idx) : String(mapKey);
            const src = idx >= 0 ? String(mapKey).slice(idx + 1) : "mic";
            applyUserVolume(uid, src);
          } catch { /* ignore */ }
          if (!(isScreenEchoCancelActive() && String(mapKey).endsWith(":mic"))) {
            el.play?.().catch(() => {});
          }
        } catch {
          /* ignore */
        }
      });
    } catch {
      /* ignore */
    }
  }

  function stopAudioCtxKeepAlive() {
    if (audioCtxKeepAliveTimer) {
      try { clearInterval(audioCtxKeepAliveTimer); } catch { /* ignore */ }
      audioCtxKeepAliveTimer = null;
    }
  }

  function startAudioCtxKeepAlive() {
    stopAudioCtxKeepAlive();
    audioCtxKeepAliveTimer = setInterval(() => {
      if (destroyed) return;
      try {
        if (audioCtx && audioCtx.state !== "closed") {
          audioCtx.resume?.().catch(() => {});
        }
        if (playbackAudioCtx && playbackAudioCtx.state !== "closed") {
          playbackAudioCtx.resume?.().catch(() => {});
        }
      } catch {
        /* ignore */
      }
    }, 1000);
  }

  async function resumePausedAudioConsumers() {
    if (destroyed || !isSfuSignalingOpen()) return;
    for (const c of Array.from(consumers.values())) {
      if (!c || c.closed || c.kind !== "audio" || !c.paused) continue;
      try {
        await sfuRequest("resumeConsumer", { consumerId: c.id });
      } catch {
        /* ignore */
      }
      try {
        await c.resume();
      } catch {
        /* ignore */
      }
    }
  }

  /**
   * SFU шлёт producerClosed/consumerClosed для любых producer'ов. Раньше обрабатывались только screen/screenAudio —
   * при закрытии mic (перезапуск трека после демонстрации, ICE, смена устройства) слушатели оставались с «зомби»-consumer'ом
   * и consumedProducerIds, поэтому resync/newProducer не создавали новый consume без перезахода в канал.
   */
  function releaseLocalSfuAudioConsumerByProducerId(producerId, fallbackUid, fallbackSrc) {
    const pid0 = String(producerId || "");
    if (!pid0) return;
    const meta = producerMetaById.get(pid0) || {};
    const uid = String(fallbackUid || meta.userId || "");
    const src = String(fallbackSrc || meta.source || "mic");
    let touched = false;
    for (const c of Array.from(consumers.values())) {
      if (String(c.producerId) !== pid0) continue;
      if (c.kind !== "audio" || !uid) continue;
      touched = true;
      try {
        teardownUserPipe(uid, src);
        removeRemoteAudioByUserAndSource(uid, src);
        try {
          const ds = directStreamByKey.get(pipeKey(uid, src));
          const tr0 = ds?.getAudioTracks?.()?.[0];
          const trc = c.track;
          if (trc && tr0 && tr0.id === trc.id) {
            directStreamByKey.delete(pipeKey(uid, src));
          }
        } catch {
          /* ignore */
        }
        consumers.delete(c.id);
        try { c.close?.(); } catch { /* ignore */ }
      } catch {
        /* ignore */
      }
    }
    consumedProducerIds.delete(pid0);
    if (touched) tryStartSpeakingMeter();
  }

  function watchMicCaptureTrack(track) {
    if (!track) return;
    try {
      track.onended = () => {
        if (destroyed || effectiveMuted()) return;
        void ensureOutboundMicHealthy().catch(() => {});
      };
    } catch {
      /* ignore */
    }
  }

  async function applyMicCaptureStream(s) {
    const rawMicTrack = s?.getAudioTracks?.()?.[0];
    if (!rawMicTrack) return;
    watchMicCaptureTrack(rawMicTrack);
    rawMicCaptureTrack = rawMicTrack;
    if (s !== localMicStream) {
      try { localMicStream?.getTracks?.().forEach((t) => t.stop()); } catch { /* ignore */ }
    }
    localMicStream = s;
    tryStartSpeakingMeter();

    const nextTrack = await rebuildMicWebAudioChain(rawMicTrack);

    nextTrack.enabled = !effectiveMuted();
    if (micProducer && !micProducer.closed) {
      await micProducer.replaceTrack?.({ track: nextTrack });
    } else if (sendTransport && !sendTransport.closed) {
      micProducer = await sendTransport.produce({ track: nextTrack, appData: { source: "mic" } });
    }
    micProducedTrack = nextTrack;
    if (!effectiveMuted()) {
      try { await micProducer?.resume?.(); } catch { /* ignore */ }
    }
  }

  let outboundHealBusy = false;
  async function ensureOutboundMicHealthy() {
    if (destroyed || outboundHealBusy) return;
    if (!sendTransport || sendTransport.closed) return;
    outboundHealBusy = true;
    try {
      const tx = String(sendTransport.connectionState || "");
      if (tx === "failed" || tx === "disconnected") {
        await restartBothSfuTransportsIce("heal-outbound-tx");
      }
      if (!micProducer || micProducer.closed) return;
      if (effectiveMuted()) return;
      const raw = rawMicCaptureTrack || localMicStream?.getAudioTracks?.()?.[0];
      const prod = micProducedTrack;
      const ended = (t) => t && String(t.readyState) === "ended";
      if (ended(raw) || ended(prod)) {
        const s = await navigator.mediaDevices.getUserMedia({
          audio: buildAudioConstraints(currentInputDeviceId || ""),
          video: false
        });
        await applyMicCaptureStream(s);
        return;
      }
      try {
        if (micProducer.paused) await micProducer.resume();
      } catch {
        /* ignore */
      }
      try {
        if (raw && !raw.enabled) raw.enabled = true;
        if (prod && !prod.enabled) prod.enabled = true;
      } catch {
        /* ignore */
      }
    } catch {
      /* ignore */
    } finally {
      outboundHealBusy = false;
    }
  }

  let inboundHealBusy = false;
  async function healStaleInboundAudio() {
    if (destroyed || inboundHealBusy) return;
    inboundHealBusy = true;
    try {
      let touched = false;
      for (const c of Array.from(consumers.values())) {
        if (c.kind !== "audio") continue;
        const tr = c.track;
        const pid = String(c.producerId || "");
        const ended = !tr || String(tr.readyState) === "ended";
        const stalled = c.paused || c.closed;
        if (!ended && !stalled) continue;
        if (!pid) continue;
        const meta = producerMetaById.get(pid) || {};
        releaseLocalSfuAudioConsumerByProducerId(pid, meta.userId, meta.source);
        touched = true;
      }
      const rx = recvTransport?.connectionState;
      if (rx === "failed" || rx === "disconnected") {
        await restartBothSfuTransportsIce("heal-inbound-rx");
        touched = true;
      }
      await resumePausedAudioConsumers();
      if (touched) await resyncRemoteProducers("heal-stale-inbound");
    } catch {
      /* ignore */
    } finally {
      inboundHealBusy = false;
    }
  }

  function startPlaybackHeal() {
    if (playbackHealTimer) return;
    playbackHealTick = 0;
    healNoAudioStreak = 0;
    // Keep running for the whole session: browsers often pause <audio> after focus/energy saving,
    // and producer lists can desync after reconnects — the 15s cap caused “random silence” in long calls.
    playbackHealTimer = setInterval(() => {
      if (destroyed) return;
      if (deafened) return;
      playbackHealTick += 1;
      if (playbackHealTick % 10 === 0) {
        void ensureOutboundMicHealthy().catch(() => {});
        void healStaleInboundAudio().catch(() => {});
      }
      if (playbackHealTick % 27 === 0) {
        void resyncRemoteProducers("periodic-heal").catch(() => {});
      }
      try { ensureAudioCtx(); } catch { /* ignore */ }
      tryPlayAllRemoteMedia();
      try {
        audioElByUserId.forEach((el, mapKey) => {
          try {
            if (!el) return;
            if (!deafened && el.muted) el.muted = false;
            if (isScreenEchoCancelActive() && String(mapKey).endsWith(":mic")) return;
            if (el.srcObject && el.paused) el.play?.().catch(() => {});
          } catch {
            /* ignore */
          }
        });
      } catch {
        /* ignore */
      }

      try {
        const hasAnyAudio = Array.from(audioElByUserId.values()).some((el) => {
          try {
            const so = el?.srcObject;
            return !!(so && so instanceof MediaStream && (so.getAudioTracks?.() || []).length);
          } catch {
            return false;
          }
        });
        if (!hasAnyAudio && (lastRoster || []).length > 1) {
          healNoAudioStreak += 1;
          if (healNoAudioStreak >= 5) {
            healNoAudioStreak = 0;
            void (async () => {
              await restartSfuTransportIce(recvTransport);
              await resumePausedAudioConsumers();
              await refreshAllRemoteAudioConsumers("heal-no-audio");
            })().catch(() => {});
          }
        } else {
          healNoAudioStreak = 0;
        }
      } catch {
        /* ignore */
      }
    }, 2200);
  }

  function stopPlaybackHeal() {
    if (!playbackHealTimer) return;
    try { clearInterval(playbackHealTimer); } catch { /* ignore */ }
    playbackHealTimer = null;
  }

  function installGestureMediaUnlock() {
    if (gestureHandler) return;
    gestureHandler = () => {
      if (destroyed) return;
      try { audioCtx?.resume?.().catch(() => {}); } catch { /* ignore */ }
      tryPlayAllRemoteMedia();
    };
    try { window.addEventListener("pointerdown", gestureHandler, { passive: true }); } catch { /* ignore */ }
    try { window.addEventListener("keydown", gestureHandler, { passive: true }); } catch { /* ignore */ }
  }

  function uninstallGestureMediaUnlock() {
    if (!gestureHandler) return;
    try { window.removeEventListener("pointerdown", gestureHandler); } catch { /* ignore */ }
    try { window.removeEventListener("keydown", gestureHandler); } catch { /* ignore */ }
    gestureHandler = null;
  }

  function installSfuVisibilityRecovery() {
    if (sfuVisibilityHandler) return;
    sfuVisibilityHandler = () => {
      if (destroyed || document.hidden) return;
      try { audioCtx?.resume?.().catch(() => {}); } catch { /* ignore */ }
      tryPlayAllRemoteMedia();
      resyncRemoteProducers("visibility").catch(() => {});
    };
    try { document.addEventListener("visibilitychange", sfuVisibilityHandler, { passive: true }); } catch { /* ignore */ }
    try { window.addEventListener("pageshow", sfuVisibilityHandler, { passive: true }); } catch { /* ignore */ }
  }

  function uninstallSfuVisibilityRecovery() {
    if (!sfuVisibilityHandler) return;
    try { document.removeEventListener("visibilitychange", sfuVisibilityHandler); } catch { /* ignore */ }
    try { window.removeEventListener("pageshow", sfuVisibilityHandler); } catch { /* ignore */ }
    sfuVisibilityHandler = null;
  }

  async function syncPlaybackOutputDevice() {
    const ctx = ensurePlaybackAudioCtx();
    if (!ctx || !outputDeviceId) return;
    try {
      if (typeof ctx.setSinkId === "function") {
        await ctx.setSinkId(outputDeviceId);
      }
    } catch {
      /* ignore */
    }
  }

  function replaceAudioElement(uid, src) {
    const pk = pipeKey(uid, src);
    teardownUserPipe(uid, src);
    const old = audioElByUserId.get(pk);
    if (old) {
      try { old.pause?.(); } catch { /* ignore */ }
      try { old.srcObject = null; } catch { /* ignore */ }
      try { old.remove?.(); } catch { /* ignore */ }
    }
    audioElByUserId.delete(pk);
    const el = makeAudioEl(uid, src);
    audioElByUserId.set(pk, el);
    return el;
  }

  /**
   * Громкость 0–300%: createMediaElementSource(el) → gain → destination.
   * Нельзя использовать createMediaStreamSource на WebRTC-треке, пока он на <audio>.
   */
  function ensureElementGainPipe(uid, src, el, directStream, allowReplace = true) {
    const ctx = ensurePlaybackAudioCtx();
    if (!ctx || !el || !directStream) return false;
    const pk = pipeKey(uid, src);
    const existing = audioPipeByKey.get(pk);
    if (existing?.mediaElementSource && existing?.gainNode) return true;
    try {
      if (el.srcObject !== directStream) el.srcObject = directStream;
      try { el.volume = 1; } catch { /* ignore */ }
      const mes = ctx.createMediaElementSource(el);
      const gainNode = ctx.createGain();
      const limiter = ensurePlaybackLimiter(ctx);
      mes.connect(gainNode);
      gainNode.connect(limiter || ctx.destination);
      const rosterAnalyser = ctx.createAnalyser();
      rosterAnalyser.fftSize = 1024;
      rosterAnalyser.smoothingTimeConstant = 0.12;
      gainNode.connect(rosterAnalyser);
      audioPipeByKey.set(pk, {
        gainNode,
        mediaElementSource: mes,
        originalStream: directStream,
        rosterAnalyser,
      });
      void syncPlaybackOutputDevice();
      trySetSink(el).catch(() => {});
      stabilizeMicAfterPlaybackGraphChange();
      return true;
    } catch {
      if (!allowReplace) return false;
      try {
        const freshEl = replaceAudioElement(uid, src);
        if (!freshEl || freshEl === el) return false;
        freshEl.srcObject = directStream;
        return ensureElementGainPipe(uid, src, freshEl, directStream, false);
      } catch {
        return false;
      }
    }
  }

  function updateUserPipeSource(uid, src, newDirectStream, el) {
    const pk = pipeKey(uid, src);
    const pipe = audioPipeByKey.get(pk);
    if (!pipe) return false;
    directStreamByKey.set(pk, newDirectStream);
    try {
      if (pipe.mediaElementSource) {
        pipe.originalStream = newDirectStream;
        if (el && el.srcObject !== newDirectStream) el.srcObject = newDirectStream;
        el?.play?.().catch(() => {});
        return true;
      }
      if (pipe.destNode) {
        teardownUserPipe(uid, src);
        return false;
      }
    } catch {
      teardownUserPipe(uid, src);
      return false;
    }
    return false;
  }
  let speakerGain = 1.0; // 0..1
  let micGain = 1.0; // 0..1
  let micGainNode = null;
  let outputDeviceId = "";
  let advancedNs = false; // авто: усиленный Chromium NS при noiseSuppressionLevel >= 70
  let noiseSuppressionLevel = 40;
  let micHighpassNode = null;
  let micLowpassNode = null;
  let micCompressorNode = null;
  let micGateGainNode = null;
  let micSourceNode = null;
  let micMeterAnalyser = null;
  let outboundGateHoldUntilMs = 0;
  let outboundGatePeakRms = 0;
  let outboundGatePeakHoldUntilMs = 0;
  let outboundGateClosedSinceMs = 0;
  let echoCancellation = true;
  let noiseSuppression = true;
  let autoGainControl = true;
  let inputSensitivityAuto = true;
  let inputSensitivity = 55; // 0..100 (higher => less sensitive)
  let currentInputDeviceId = "";
  let micProducedTrack = null;
  let rawMicCaptureTrack = null;
  let localNoiseFloor = 0.02;
  let lastLocalRms = 0;
  let lastLocalEffectiveRms = 0;
  let lastLocalMeterRms = 0;
  let lastMeterAtMs = 0;
  let lastLocalThreshold = 0.03;
  let lastLocalGateOpen = false;
  let lastLocalMicSpeaking = false;
  let peakHoldUntilMs = 0;
  let peakRms = 0;
  /** Последний момент, когда локальный голос считался «выше порога» (для пауз между словами). */
  let lastLocalSpeechAtMs = 0;
  const METER_SPEAK_TAIL_MS = 220;

  function buildAudioConstraints(deviceId) {
    const level = Math.max(0, Math.min(100, Number(noiseSuppressionLevel) || 0));
    const useStrongNs = !!noiseSuppression && level > 0;
    const aggressiveNs = useStrongNs && level >= 85;
    const effectiveAgc = !!autoGainControl && level < 75;
    const useAdvanced = useStrongNs && level >= 70;
    const base = {
      echoCancellation: !!echoCancellation,
      noiseSuppression: useStrongNs,
      autoGainControl: effectiveAgc
    };
    if (useStrongNs && level >= 85) {
      try { base.voiceIsolation = true; } catch { /* ignore */ }
    }
    if (useAdvanced) {
      // Non-standard constraints used by Chromium; ignored elsewhere.
      base.googNoiseSuppression = true;
      base.googHighpassFilter = true;
      base.googEchoCancellation = !!echoCancellation;
      base.googAutoGainControl = effectiveAgc;
      base.googTypingNoiseDetection = true;
      if (level >= 80) {
        try { base.googNoiseReduction = true; } catch { /* ignore */ }
      }
    }
    if (deviceId) {
      base.deviceId = { exact: String(deviceId) };
    }
    return base;
  }

  function teardownMicProcessingNodes() {
    try { micHighpassNode?.disconnect?.(); } catch { /* ignore */ }
    try { micLowpassNode?.disconnect?.(); } catch { /* ignore */ }
    try { micCompressorNode?.disconnect?.(); } catch { /* ignore */ }
    micHighpassNode = null;
    micLowpassNode = null;
    micCompressorNode = null;
  }

  function readAnalyserRms(analyser) {
    if (!analyser) return 0;
    try {
      const data = getRmsScratch(analyser.fftSize);
      analyser.getByteTimeDomainData(data);
      let sum = 0;
      for (let i = 0; i < data.length; i++) {
        const v = (data[i] - 128) / 128;
        sum += v * v;
      }
      return Math.sqrt(sum / data.length);
    } catch {
      return 0;
    }
  }

  function clearLocalMeterAnalyserEntry() {
    try {
      const entry = speakingAnalysers.get(`meter-${selfUserId}`);
      if (entry) {
        try { entry.src?.disconnect?.(); } catch { /* ignore */ }
        speakingAnalysers.delete(`meter-${selfUserId}`);
      }
    } catch { /* ignore */ }
  }

  /** Один MediaStreamSource на микрофон; метр — ответвление через AnalyserNode (второй source ломает исходящий звук). */
  async function rebuildMicWebAudioChain(rawMicTrack) {
    if (!rawMicTrack || rawMicTrack.readyState === "ended") return rawMicTrack;
    const ctx = await ensureAudioCtxRunning();
    if (!ctx) return rawMicTrack;
    try {
      try { micSourceNode?.disconnect?.(); } catch { /* ignore */ }
      micSourceNode = null;
      clearLocalMeterAnalyserEntry();

      if (!micGateGainNode) micGateGainNode = ctx.createGain();
      if (!micGainNode) micGainNode = ctx.createGain();
      try { micGateGainNode.disconnect(); } catch { /* ignore */ }
      try { micGainNode.disconnect(); } catch { /* ignore */ }
      micGainNode.gain.value = micGain;
      micGateGainNode.gain.value = initialOutboundGateGain();

      const src = ctx.createMediaStreamSource(new MediaStream([rawMicTrack]));
      micSourceNode = src;
      if (!micMeterAnalyser) {
        micMeterAnalyser = ctx.createAnalyser();
        micMeterAnalyser.fftSize = 1024;
        micMeterAnalyser.smoothingTimeConstant = 0.12;
      }
      try { src.connect(micMeterAnalyser); } catch { /* ignore */ }

      const dest = ctx.createMediaStreamDestination();
      connectMicProcessingChain(ctx, src, micGateGainNode);
      micGateGainNode.connect(micGainNode);
      micGainNode.connect(dest);
      return dest.stream.getAudioTracks()[0] || rawMicTrack;
    } catch {
      return rawMicTrack;
    }
  }

  function computeSpeakingMeterThreshold() {
    if (!inputSensitivityAuto) {
      const strict = Math.max(0, Math.min(1, (Number(inputSensitivity) || 50) / 100));
      return 0.005 + strict * 0.038;
    }
    return Math.max(0.0045, localNoiseFloor * 1.1 + 0.0015);
  }

  function initialOutboundGateGain() {
    if (effectiveMuted()) return 0;
    return 1;
  }

  /** Голос в эфир не гейтится — только mute пользователя. */
  function ensureMicTransmitGain() {
    if (!audioCtx || !micGateGainNode) return;
    const target = effectiveMuted() ? 0 : 1;
    try {
      micGateGainNode.gain.setTargetAtTime(target, audioCtx.currentTime, 0.02);
      if (micGainNode) {
        micGainNode.gain.setTargetAtTime(micGain, audioCtx.currentTime, 0.02);
      }
    } catch { /* ignore */ }
    lastLocalGateOpen = !effectiveMuted();
  }

  function connectMicProcessingChain(ctx, src, dest) {
    teardownMicProcessingNodes();
    const level = Math.max(0, Math.min(100, Number(noiseSuppressionLevel) || 0));
    if (!noiseSuppression || level < 45) {
      src.connect(dest);
      return;
    }
    let node = src;
    const t = level / 100;
    try {
      const hp = ctx.createBiquadFilter();
      hp.type = "highpass";
      hp.frequency.value = 75 + t * 55;
      hp.Q.value = 0.7;
      node.connect(hp);
      node = hp;
      micHighpassNode = hp;
    } catch {
      /* ignore */
    }
    if (level >= 50) {
      try {
        const lp = ctx.createBiquadFilter();
        lp.type = "lowpass";
        lp.frequency.value = 15000 - t * 3500;
        lp.Q.value = 0.65;
        node.connect(lp);
        node = lp;
        micLowpassNode = lp;
      } catch {
        /* ignore */
      }
    }
    if (level >= 58) {
      try {
        const comp = ctx.createDynamicsCompressor();
        comp.threshold.value = -26 - t * 10;
        comp.knee.value = 8 + t * 6;
        comp.ratio.value = 2.5 + t * 3.5;
        comp.attack.value = 0.006;
        comp.release.value = 0.1 + (1 - t) * 0.06;
        node.connect(comp);
        node = comp;
        micCompressorNode = comp;
      } catch {
        /* ignore */
      }
    }
    node.connect(dest);
  }

  let rosterMutedSnapshot = [];
  const sfuSignaling = createSfuRequester((obj) => sfuSend(obj));
  const sfuRequest = sfuSignaling.sfuRequest;

  function setState(patch) {
    onState((prev) => {
      const base = typeof patch === "function" ? patch(prev) : { ...prev, ...patch };
      const next = voiceFsm.uiPatch(base as Record<string, unknown>);
      rosterMutedSnapshot = ((next as { mutedUserIds?: string[] }).mutedUserIds || []).map((x) => String(x));
      return next;
    });
  }

  // Best-effort: unlock AudioContext on user gesture (prevents silent gain-pipeline).
  try {
    audioCtxUnlockHandler = () => {
      try { audioCtx?.resume?.().catch(() => {}); } catch { /* ignore */ }
    };
    window.addEventListener("pointerdown", audioCtxUnlockHandler, { passive: true });
    window.addEventListener("keydown", audioCtxUnlockHandler, { passive: true });
  } catch {
    // ignore
  }

  function tryStartSpeakingMeter() {
    if (speakingTimer) return;
    if (!window.AudioContext && !window.webkitAudioContext) return;
    if (!audioCtx) {
      audioCtx = createVoiceAudioContext();
      if (!audioCtx) return;
    }
    /** userId -> ms (подсветка активна пока now <= expiry). */
    const rosterSpeakUntilMs = new Map();
    let lastSentSpeaking = false;
    let lastSpeakingSentAt = 0;
    /** Порог только для подсветки ростера (мягче, чем «Говорю» в настройках). */
    const ROSTER_SPEAK_THR = 0.009;
    /** Короткий хвост после последнего кадра выше порога — без peak-hold (он давал 1–2 с). */
    const ROSTER_SPEAK_TAIL_MS = 380;

    function ensureMeterAudioCtx() {
      if (!window.AudioContext && !window.webkitAudioContext) return null;
      const ctx = ensureAudioCtx();
      try {
        if (ctx?.state === "suspended") ctx.resume?.().catch(() => {});
      } catch { /* ignore */ }
      return ctx && ctx.state !== "closed" ? ctx : null;
    }

    function measureStreamRms(uid, stream, opts) {
      if (!stream || !(stream instanceof MediaStream)) return 0;
      const rosterMeter = !!opts?.roster;
      const ctx = rosterMeter ? ensurePlaybackAudioCtx() : ensureMeterAudioCtx();
      if (!ctx) return 0;
      const track = stream.getAudioTracks?.()?.[0];
      if (!track || track.readyState === "ended") return 0;
      const trackId = track.id || "";
      const streamKey = `${stream.id}:${trackId}`;
      let entry = speakingAnalysers.get(String(uid));
      if (!entry || entry.streamKey !== streamKey || !!entry.rosterMeter !== rosterMeter) {
        try { entry?.src?.disconnect?.(); } catch { /* ignore */ }
        try {
          const srcNode = ctx.createMediaStreamSource(stream);
          const an = ctx.createAnalyser();
          an.fftSize = 1024;
          an.smoothingTimeConstant = rosterMeter ? 0.12 : 0.35;
          srcNode.connect(an);
          entry = { analyser: an, streamKey, src: srcNode, meterTrack: track, rosterMeter };
          speakingAnalysers.set(String(uid), entry);
        } catch {
          return 0;
        }
      }
      const an = entry.analyser;
      const data = getRmsScratch(an.fftSize);
      an.getByteTimeDomainData(data);
      let sum = 0;
      for (let i = 0; i < data.length; i++) {
        const v = (data[i] - 128) / 128;
        sum += v * v;
      }
      return Math.sqrt(sum / data.length);
    }

    function collectRemoteMicStreams() {
      const out = new Map();
      for (const c of consumers.values()) {
        if (!c || c.closed || c.kind !== "audio") continue;
        const pid = String(c.producerId || "");
        const meta = producerMetaById.get(pid) || {};
        const srcKind = String(meta.source || c.appData?.source || "mic");
        if (srcKind && srcKind !== "mic") continue;
        const uid = String(meta.userId || c.appData?.remoteUserId || "");
        if (!uid) continue;
        const meterStream = getCachedMeterStream(`remote-${uid}`, c.track);
        if (meterStream) out.set(uid, meterStream);
      }
      for (const [key, stream] of directStreamByKey.entries()) {
        if (!String(key).endsWith(":mic")) continue;
        const uid = String(key).slice(0, -4);
        if (!uid || out.has(uid)) continue;
        const track = stream?.getAudioTracks?.()?.[0];
        if (!track || track.readyState === "ended") continue;
        const meterStream = getCachedMeterStream(`remote-${uid}`, track);
        if (meterStream) out.set(uid, meterStream);
      }
      return out;
    }

    function collectPipeMicRms(now) {
      for (const [key, pipe] of audioPipeByKey.entries()) {
        if (!String(key).endsWith(":mic")) continue;
        const uid = String(key).slice(0, -4);
        if (!uid || !pipe?.rosterAnalyser) continue;
        try {
          const rms = readAnalyserRms(pipe.rosterAnalyser);
          markRosterSpeaking(uid, rms, now);
        } catch {
          /* ignore */
        }
      }
    }

    function markRosterSpeaking(uid, level, now) {
      const id = String(uid);
      if (!id) return;
      const rms = Math.max(0, Number(level) || 0);
      if (rms <= ROSTER_SPEAK_THR) return;
      const until = now + ROSTER_SPEAK_TAIL_MS;
      const prev = rosterSpeakUntilMs.get(id) || 0;
      if (until > prev) rosterSpeakUntilMs.set(id, until);
    }

    speakingTimer = setInterval(() => {
      if (destroyed) return;
      const now = Date.now();
      const speakingSet = new Set();

      if (deafened) {
        setState((prev) => (
          (prev.speakingUserIds || []).length
            ? { ...prev, speakingUserIds: [] }
            : prev
        ));
        return;
      }

      const meterReady = ensureMeterAudioCtx();

      // local speaking (mic) — только индикатор/ростер, без гейта на эфир
      if (meterReady) {
        try {
          if (localMicStream) {
            const rms = readAnalyserRms(micMeterAnalyser);

            if (inputSensitivityAuto) {
              const downK = 0.22;
              const upK = rms > localNoiseFloor * 1.25 ? 0.12 : 0.05;
              const k = rms < localNoiseFloor ? downK : upK;
              localNoiseFloor = localNoiseFloor * (1 - k) + rms * k;
              localNoiseFloor = Math.max(0.0025, Math.min(0.07, localNoiseFloor));
            }

            const speakThr = computeSpeakingMeterThreshold();
            const speakingNow = rms > speakThr * 0.88;
            if (speakingNow) lastLocalSpeechAtMs = now;
            const indicatorOn = speakingNow || (now - lastLocalSpeechAtMs < METER_SPEAK_TAIL_MS);

            if (!effectiveMuted()) {
              markRosterSpeaking(selfUserId, rms, now);
            }

            lastLocalMicSpeaking = !effectiveMuted() && indicatorOn;
            ensureMicTransmitGain();

            lastLocalRms = rms;
            lastLocalEffectiveRms = rms;
            lastLocalThreshold = speakThr;

            const prevAt = lastMeterAtMs || now;
            const dt = Math.max(1, now - prevAt);
            lastMeterAtMs = now;
            const decay = Math.exp(-dt / 1200);
            lastLocalMeterRms = Math.max(rms, lastLocalMeterRms * decay);
          } else {
            lastLocalMicSpeaking = false;
            lastLocalRms = 0;
            lastLocalEffectiveRms = 0;
            peakRms = 0;
          }
        } catch {
          lastLocalMicSpeaking = false;
        }

        // remote speaking: mic consumers (не зависим от скрытого <audio> и WebAudio pipe).
        try {
          const mutedRemote = new Set(rosterMutedSnapshot);
          const remoteStreams = collectRemoteMicStreams();
          const activeRemote = new Set(remoteStreams.keys());
          for (const uid of Array.from(rosterSpeakUntilMs.keys())) {
            if (!activeRemote.has(uid) && String(uid) !== String(selfUserId)) {
              rosterSpeakUntilMs.delete(uid);
              releaseRosterMeterClone(`remote-${uid}`);
              const meterEntry = speakingAnalysers.get(String(uid));
              if (meterEntry) {
                try { meterEntry.src?.disconnect?.(); } catch { /* ignore */ }
                speakingAnalysers.delete(String(uid));
              }
            }
          }
          for (const [uid, so] of remoteStreams.entries()) {
            if (mutedRemote.has(String(uid))) continue;
            try {
              const rms = measureStreamRms(String(uid), so, { roster: true });
              markRosterSpeaking(uid, rms, now);
            } catch {
              /* ignore */
            }
          }
          collectPipeMicRms(now);
        } catch {
          // ignore
        }

        const selfUntil = rosterSpeakUntilMs.get(String(selfUserId)) || 0;
        const selfSpeakingNow = !effectiveMuted() && now <= selfUntil;
        if (
          selfSpeakingNow !== lastSentSpeaking
          || (selfSpeakingNow && now - lastSpeakingSentAt > 1000)
        ) {
          lastSentSpeaking = selfSpeakingNow;
          lastSpeakingSentAt = now;
          sendPresence({ type: "setSpeaking", roomId, speaking: selfSpeakingNow });
        }
      } else {
        lastLocalMicSpeaking = false;
      }

      for (const [uid, until] of rosterSpeakUntilMs.entries()) {
        if (now <= until) speakingSet.add(String(uid));
        else rosterSpeakUntilMs.delete(uid);
      }
      for (const [uid, until] of rosterSpeakingExpiryMs.entries()) {
        if (now <= until) speakingSet.add(String(uid));
        else rosterSpeakingExpiryMs.delete(uid);
      }

      setState((prev) => {
        const muted = new Set((prev.mutedUserIds || []).map((x) => String(x)));
        if (effectiveMuted()) muted.add(String(selfUserId));
        const nextIds = Array.from(speakingSet).filter((uid) => uid && !muted.has(String(uid)));
        const prevIds = (prev.speakingUserIds || []).map((x) => String(x));
        if (prevIds.length === nextIds.length && prevIds.every((x, i) => x === nextIds[i])) {
          return prev;
        }
        return { ...prev, speakingUserIds: nextIds };
      });
    }, 120);
  }

  function sendPresence(obj) {
    presenceClient?.send(obj as Record<string, unknown>);
  }

  function persistVoicePrefs() {
    try { localStorage.setItem(LS_MIC, micEnabledWanted ? "1" : "0"); } catch { /* ignore */ }
    try { localStorage.setItem(LS_DEAF, deafened ? "1" : "0"); } catch { /* ignore */ }
  }

  function effectiveMuted() {
    return deafened || !micEnabledWanted;
  }

  function applyLocalMuteDeafen() {
    const mutedNow = effectiveMuted();
    if (deafened) {
      setState((prev) => (
        (prev.speakingUserIds || []).length ? { ...prev, speakingUserIds: [] } : prev
      ));
    } else {
      try { audioCtx?.resume?.().catch(() => {}); } catch { /* ignore */ }
      tryPlayAllRemoteMedia();
    }
    try {
      localMicStream?.getAudioTracks?.().forEach((t) => { t.enabled = !mutedNow; });
      micProducedTrack && (micProducedTrack.enabled = !mutedNow);
    } catch { /* ignore */ }
    try {
      if (micProducer) {
        if (mutedNow) micProducer.pause?.();
        else micProducer.resume?.();
      }
    } catch { /* ignore */ }
    try { remoteAudioHost?.querySelectorAll?.("audio")?.forEach((el) => { el.muted = deafened; }); } catch { /* ignore */ }
    if (isScreenEchoCancelActive()) {
      silenceMicPlaybackForScreenEcho();
      syncScreenEchoVoiceRef();
    }
    setState({ muted: mutedNow, deafened });
    persistVoicePrefs();
    sendPresence({ type: "setUserFlags", roomId, muted: mutedNow, deafened });
  }

  function stopCredentialRefreshTimer() {
    if (credentialRefreshTimer) clearInterval(credentialRefreshTimer);
    credentialRefreshTimer = null;
  }

  function startCredentialRefreshTimer() {
    stopCredentialRefreshTimer();
    if (useVoiceGateway) return;
    const ttl = Math.max(120, Number(liveTokenTtlSeconds) || 43200);
    const refreshMs = Math.max(60_000, (ttl - 120) * 1000);
    credentialRefreshTimer = setInterval(() => {
      if (destroyed) return;
      void applyFreshSfuCredentials(false).catch(() => {});
    }, refreshMs);
  }

  function makeAudioEl(peerId, source) {
    const id = audioDomId(peerId, source);
    let el = document.getElementById(id);
    if (el) return el;
    el = document.createElement("audio");
    el.id = id;
    el.autoplay = true;
    el.playsInline = true;
    el.controls = false;
    el.setAttribute("playsinline", "true");
    el.muted = deafened;
    remoteAudioHost.appendChild(el);
    return el;
  }

  async function trySetSink(el) {
    if (!el) return;
    if (!outputDeviceId) return;
    try {
      if (typeof el.setSinkId === "function") {
        await el.setSinkId(outputDeviceId);
      }
    } catch {
      // ignore (unsupported or denied)
    }
  }

  function ensureAudioCtx() {
    if (!window.AudioContext && !window.webkitAudioContext) return null;
    if (!audioCtx || audioCtx.state === "closed") {
      audioCtx = createVoiceAudioContext();
      if (!audioCtx) return null;
    }
    try { audioCtx.resume?.().catch(() => {}); } catch { /* ignore */ }
    // Still return the context while "suspended": gain/mic pipelines should exist; resume runs from gestures / keepalive.
    if (audioCtx.state === "closed") return null;
    return audioCtx;
  }

  async function ensureAudioCtxRunning() {
    const ctx = ensureAudioCtx();
    if (!ctx) return null;
    if (ctx.state === "suspended") {
      try {
        await ctx.resume();
      } catch {
        /* ignore */
      }
    }
    return ctx.state === "closed" ? null : ctx;
  }

  function getUserVolumeMultiplier(userId) {
    try {
      const raw = localStorage.getItem("sloncord_voice_user_volumes") || "{}";
      const m = JSON.parse(raw) || {};
      const v = Number(m[String(userId)] ?? 100);
      const clamped = Math.max(0, Math.min(300, Number.isFinite(v) ? v : 100));
      return clamped / 100;
    } catch {
      return 1.0;
    }
  }

  function makeVideoEl(peerId, source) {
    const pid = String(peerId).replace(/[^a-f0-9-]/gi, "x");
    // IMPORTANT: screen viewer UI expects `remote-video-${peerId}`.
    // Keep this id for screen share so existing `openScreenView()` works.
    // For camera/other video sources, use a suffix to avoid collisions.
    const src = String(source || "");
    const suf = (src && src !== "screen") ? `-${src.replace(/[^a-z0-9_-]/gi, "x")}` : "";
    const id = `remote-video-${pid}${suf}`;
    let el = document.getElementById(id);
    if (el) return el;
    el = document.createElement("video");
    el.id = id;
    el.autoplay = true;
    el.playsInline = true;
    el.controls = false;
    el.muted = true;
    el.setAttribute("playsinline", "true");
    (remoteVideoHost || document.querySelector(".voice-video-stage"))?.appendChild(el);
    return el;
  }

  function removeMediaEls(peerId) {
    const pid = String(peerId).replace(/[^a-f0-9-]/gi, "x");
    try {
      document.querySelectorAll?.(`[id^="sfu-remote-audio-${pid}:"]`)?.forEach?.((x) => x.remove());
    } catch { /* ignore */ }
    try {
      document.querySelectorAll?.(`[id^="remote-video-${pid}"]`)?.forEach?.((x) => x.remove());
    } catch {
      // ignore
    }
  }

  function removeRemoteAudioByUserAndSource(userId, source) {
    const pid = String(userId).replace(/[^a-f0-9-]/gi, "x");
    const src = String(source || "mic").replace(/[^a-z0-9_-]/gi, "x");
    const id = `sfu-remote-audio-${pid}:${src}`;
    try { document.getElementById(id)?.remove?.(); } catch { /* ignore */ }
    try { audioElByUserId.delete(`${String(userId)}:${String(source || "mic")}`); } catch { /* ignore */ }
  }

  function sfuSend(obj) {
    if (useVoiceGateway) {
      if (!presenceClient?.getSocket() || presenceClient.getSocket()?.readyState !== WebSocket.OPEN) {
        throw new Error("Voice gateway не подключен");
      }
      if (!presenceClient.isGatewayReady()) throw new Error("SFU gateway не готов");
      sendPresence({ type: "sfu", body: obj });
      return;
    }
    if (!sfuWs || sfuWs.readyState !== WebSocket.OPEN) throw new Error("SFU WebSocket не подключен");
    sfuWs.send(JSON.stringify(obj));
  }

  async function handleSfuInboundMessage(msg) {
    if (!msg || typeof msg !== "object") return;

    const sig = sfuSignaling.handleResponse(msg as Record<string, unknown>);
    if (sig.kind === "pong") {
      lastSfuPongAt = Date.now();
      return;
    }
    if (sig.kind === "handled") return;

    if (msg.type === "newProducer") {
      const pid = String(msg.producerId);
      sfuConsumeProducer(pid)
        .then(() => {
          try {
            const meta = producerMetaById.get(pid);
            const uid = String(meta?.userId || "");
            const src = String(meta?.source || "");
            if (uid && src === "screen") {
              const t = pendingScreenEndTimers.get(uid);
              if (t) {
                try { clearTimeout(t); } catch { /* ignore */ }
                pendingScreenEndTimers.delete(uid);
              }
              refreshScreenViewForPeer(uid);
              setState((prev) => ({
                ...prev,
                screenShareUserIds: Array.from(new Set([...(prev.screenShareUserIds || []), uid]))
              }));
            }
          } catch {
            /* ignore */
          }
        })
        .catch(() => {});
      return;
    }
    if (msg.type === "producerClosed") {
      const pid = String(msg.producerId || "");
      const uid = String(msg.userId || producerMetaById.get(pid)?.userId || "");
      const src = String(msg?.appData?.source || producerMetaById.get(pid)?.source || "");
      const kind = String(msg.kind || "");
      const screenish = src === "screen" || src === "screenAudio";
      if (kind === "audio" && !screenish) {
        releaseLocalSfuAudioConsumerByProducerId(pid, uid, src || "mic");
        void resyncRemoteProducers("producerClosed-voice").catch(() => {});
      }
      producerMetaById.delete(pid);
      if (uid && (src === "screen" || src === "screenAudio")) {
        if (src === "screen") {
          detachScreenViewForPeer(uid);
          const prevT = pendingScreenEndTimers.get(uid);
          if (prevT) {
            try { clearTimeout(prevT); } catch { /* ignore */ }
            pendingScreenEndTimers.delete(uid);
          }
          const t = setTimeout(() => {
            pendingScreenEndTimers.delete(uid);
            setState((prev) => ({
              ...prev,
              screenShareUserIds: (prev.screenShareUserIds || []).filter((x) => String(x) !== uid)
            }));
            closeViewerForPeer(uid);
          }, 1400);
          pendingScreenEndTimers.set(uid, t);
        } else {
          removeRemoteAudioByUserAndSource(uid, "screenAudio");
          tryStartSpeakingMeter();
        }
      }
      return;
    }
    if (msg.type === "consumerClosed") {
      const pid = String(msg.producerId || "");
      const uid = String(msg?.appData?.remoteUserId || producerMetaById.get(pid)?.userId || "");
      const src = String(msg?.appData?.source || producerMetaById.get(pid)?.source || "");
      const screenish = src === "screen" || src === "screenAudio";
      if (uid && screenish) {
        if (src === "screen") {
          setState((prev) => ({
            ...prev,
            screenShareUserIds: (prev.screenShareUserIds || []).filter((x) => String(x) !== uid)
          }));
          closeViewerForPeer(uid);
        } else {
          removeRemoteAudioByUserAndSource(uid, "screenAudio");
          tryStartSpeakingMeter();
        }
      } else if (pid) {
        releaseLocalSfuAudioConsumerByProducerId(pid, uid, src || "mic");
        void resyncRemoteProducers("consumerClosed-remote").catch(() => {});
      }
      producerMetaById.delete(pid);
      return;
    }
    if (msg.type === "peerLeft") {
      cleanupDepartedPeer(String(msg.fromUserId || msg.userId || ""));
    }
  }

  function cleanupDepartedPeer(uid0: string) {
    const uid = String(uid0 || "");
    if (!uid) return;
    const prefix = `${uid}:`;
    for (const key of Array.from(audioPipeByKey.keys())) {
      if (!String(key).startsWith(prefix)) continue;
      const src = String(key).slice(prefix.length);
      teardownUserPipe(uid, src);
    }
    for (const key of Array.from(directStreamByKey.keys())) {
      if (String(key).startsWith(prefix)) directStreamByKey.delete(key);
    }
    for (const key of Array.from(audioElByUserId.keys())) {
      if (String(key).startsWith(prefix)) audioElByUserId.delete(key);
    }
    for (const pid of Array.from(consumedProducerIds)) {
      const meta = producerMetaById.get(pid) || {};
      if (String(meta.userId || "") === uid) {
        releaseLocalSfuAudioConsumerByProducerId(pid, uid, meta.source);
      }
    }
    removeMediaEls(uid);
    for (const key of Array.from(speakingAnalysers.keys())) {
      if (key === uid || key === `remote-${uid}`) {
        try { speakingAnalysers.get(key)?.src?.disconnect?.(); } catch { /* ignore */ }
        speakingAnalysers.delete(key);
      }
    }
    releaseRosterMeterClone(`remote-${uid}`);
    closeViewerForPeer(uid);
    setState((prev) => ({
      ...prev,
      rosterUserIds: (prev.rosterUserIds || []).filter((x) => String(x) !== uid),
      screenShareUserIds: (prev.screenShareUserIds || []).filter((x) => String(x) !== uid),
    }));
  }

  function handleRoomRoster(msg: Record<string, unknown>) {
    const ids = ((msg.userIds as unknown[]) || []).map((x) => String(x));
    const prevIds = (lastRoster || []).map((x) => String(x));
    const rosterMembershipChanged = ids.length !== prevIds.length
      || ids.some((id, i) => id !== prevIds[i]);
    const nextSet = new Set(ids);
    for (const uid of prevIds) {
      if (!uid || nextSet.has(uid)) continue;
      cleanupDepartedPeer(uid);
    }
    lastRoster = ids;
    const mutedIds = ((msg.mutedUserIds as unknown[]) || []).map((x) => String(x));
    const deafIds = ((msg.deafenedUserIds as unknown[]) || []).map((x) => String(x));
    const sharers = ((msg.screenShareUserIds as unknown[]) || []).map((x) => String(x)).filter(Boolean);
    try {
      const prevSharers = (lastSharers || []).map((x) => String(x)).filter(Boolean);
      const nextSet = new Set(sharers);
      for (const uid0 of prevSharers) {
        const uid = String(uid0 || "");
        if (!uid) continue;
        if (nextSet.has(uid)) continue;
        const t = pendingScreenEndTimers.get(uid);
        if (t) {
          try { clearTimeout(t); } catch { /* ignore */ }
          pendingScreenEndTimers.delete(uid);
        }
        closeViewerForPeer(uid);
      }
    } catch { /* ignore */ }
    lastSharers = sharers.slice(0);
    const speakingIds = ((msg.speakingUserIds as unknown[]) || []).map((x) => String(x)).filter(Boolean);
    rosterSpeakingFromServer = new Set(speakingIds);
    const rosterNow = Date.now();
    for (const uid of speakingIds) {
      rosterSpeakingExpiryMs.set(String(uid), rosterNow + 1600);
    }
    setState((prev) => {
      const prevSpeaking = (prev.speakingUserIds || []).map((x) => String(x));
      const speakingSame = prevSpeaking.length === speakingIds.length
        && prevSpeaking.every((x, i) => x === speakingIds[i]);
      const prevMuted = (prev.mutedUserIds || []).map((x) => String(x));
      const mutedSame = prevMuted.length === mutedIds.length
        && prevMuted.every((x, i) => x === mutedIds[i]);
      const prevDeaf = (prev.deafenedUserIds || []).map((x) => String(x));
      const deafSame = prevDeaf.length === deafIds.length
        && prevDeaf.every((x, i) => x === deafIds[i]);
      const prevRoster = (prev.rosterUserIds || []).map((x) => String(x));
      const rosterSame = prevRoster.length === ids.length
        && prevRoster.every((x, i) => x === ids[i]);
      const prevSharersList = (prev.screenShareUserIds || []).map((x) => String(x));
      const sharersSame = prevSharersList.length === sharers.length
        && prevSharersList.every((x, i) => x === sharers[i]);
      if (rosterSame && mutedSame && deafSame && sharersSame && speakingSame) return prev;
      return {
        ...prev,
        rosterUserIds: ids,
        mutedUserIds: mutedIds,
        deafenedUserIds: deafIds,
        screenShareUserIds: sharers,
      };
    });
    if (rosterMembershipChanged && ids.length > 1) {
      setTimeout(() => resyncRemoteProducers("roster-update").catch(() => {}), 250);
    }
  }

  presenceClient = createPresenceClient({
    token,
    roomId,
    useVoiceGateway: () => useVoiceGateway,
    isDestroyed: () => destroyed,
    voiceFsm,
    onForceLeave: () => {
      if (typeof onForceLeave === "function") {
        try { onForceLeave(); } catch { /* ignore */ }
      }
    },
    onVoiceMove: (channelId) => {
      if (typeof onVoiceMove === "function") {
        try { onVoiceMove(channelId); } catch { /* ignore */ }
      }
    },
    onSfuEnvelope: (body) => { void handleSfuInboundMessage(body); },
    onSfuReady: () => {},
    onSfuBridgeRefreshed: () => {
      void recoverFromSignalingDrop("bridge-refreshed", true).catch(() => {});
    },
    onSfuError: () => {},
    onRoomRoster: handleRoomRoster,
    onPeerLeft: (msg) => { cleanupDepartedPeer(String(msg.fromUserId || msg.userId || "")); },
    onReconnectSuccess: () => {
      if (useVoiceGateway) {
        void recoverAfterPresenceReconnect().catch(() => {});
      } else {
        void recoverFromSignalingDrop("presence-reconnect", true).catch(() => {});
      }
    },
    getScreenSharing: () => !!screenProducer,
    scheduleMediaRebuild: (reason, skipGateway) => {
      void mediaRebuildFn?.(reason, false, skipGateway).catch(() => {});
    },
    resyncProducers: (reason) => { resyncRemoteProducers(reason).catch(() => {}); },
    tryPlayRemote: () => { tryPlayAllRemoteMedia(); },
  });

  function getUserVolumePct(userId) {
    const cached = userVolumePctByUserId.get(String(userId));
    if (cached != null) return Math.max(0, Math.min(300, Number(cached) || 0));
    try {
      const raw = localStorage.getItem("sloncord_voice_user_volumes") || "{}";
      const m = JSON.parse(raw) || {};
      const v = Number(m[String(userId)] ?? 100);
      return Math.max(0, Math.min(300, Number.isFinite(v) ? v : 100));
    } catch {
      return 100;
    }
  }

  function volumePctToGain(pct) {
    const p = Math.max(0, Math.min(300, Number(pct) || 0));
    if (p <= 100) return p / 100;
    // Boost above 100% via WebAudio (max ~9× at 300%).
    const t = (p - 100) / 200; // 0..1
    return 1 + t * 8; // 1..9
  }

  function isScreenEchoCancelActive() {
    return !!(screenVoiceEchoRef && isNativeScreenAudioActive());
  }

  function silenceMicPlaybackForScreenEcho() {
    try {
      audioElByUserId.forEach((el, mapKey) => {
        if (!String(mapKey).endsWith(":mic")) return;
        const idx = String(mapKey).indexOf(":");
        const uid = idx >= 0 ? String(mapKey).slice(0, idx) : String(mapKey);
        teardownUserPipe(uid, "mic");
        try { el.volume = 0; } catch { /* ignore */ }
        try { el.muted = !!deafened; } catch { /* ignore */ }
        try { el.pause(); } catch { /* ignore */ }
      });
    } catch {
      /* ignore */
    }
  }

  function getMicEffectiveGain(uid, volumePctOverride) {
    const pct = volumePctOverride != null
      ? Math.max(0, Math.min(300, Number(volumePctOverride) || 0))
      : getUserVolumePct(uid);
    const baseGain = volumePctToGain(pct);
    return deafened ? 0 : baseGain * speakerGain;
  }

  function syncScreenEchoVoiceRef() {
    if (!screenVoiceEchoRef) return;
    const entries = [];
    try {
      for (const [key, direct] of directStreamByKey.entries()) {
        if (!String(key).endsWith(":mic")) continue;
        const colon = String(key).indexOf(":");
        const uid = colon >= 0 ? String(key).slice(0, colon) : String(key);
        const track = direct?.getAudioTracks?.()?.[0];
        if (!track || track.readyState === "ended") continue;
        entries.push({
          key: String(key),
          track,
          gain: getMicEffectiveGain(uid),
        });
      }
    } catch {
      /* ignore */
    }
    void screenVoiceEchoRef.sync(entries).catch(() => {});
  }

  async function startScreenVoiceEchoRef() {
    if (!isNativeScreenAudioActive()) return;
    const port = getNativeScreenCapturePort();
    if (!port) return;
    try {
      if (!screenVoiceEchoRef) screenVoiceEchoRef = new ScreenAudioVoiceRef();
      await screenVoiceEchoRef.start(port, outputDeviceId);
      silenceMicPlaybackForScreenEcho();
      syncScreenEchoVoiceRef();
      refreshAllRemoteVoiceVolumesAfterScreenShareToggle();
    } catch {
      /* ignore */
    }
  }

  async function stopScreenVoiceEchoRef() {
    const ref = screenVoiceEchoRef;
    screenVoiceEchoRef = null;
    try {
      await ref?.stop?.();
    } catch {
      /* ignore */
    }
  }

  function applyDirectElementVolume(el, eff) {
    try { el.muted = !!deafened; } catch { /* ignore */ }
    trySetSink(el).catch(() => {});
    try { el.volume = Math.max(0, Math.min(1, eff)); } catch { /* ignore */ }
    try { ensurePlaybackAudioCtx()?.resume?.(); } catch { /* ignore */ }
    el.play?.().catch(() => {});
  }

  function applyUserVolume(userId, source, volumePctOverride) {
    const resolved = resolvePlaybackElement(userId, source);
    if (!resolved) return;
    const { pk, uid, src } = resolved;
    let el = resolved.el;

    const pct = volumePctOverride != null
      ? Math.max(0, Math.min(300, Number(volumePctOverride) || 0))
      : (src === "screenAudio" ? 100 : getUserVolumePct(uid));
    const screenMult = src === "screenAudio"
      ? screenVolumePctToGain(Number(screenAudioPctByUserId.get(uid) ?? 0))
      : 1.0;
    const baseGain = volumePctToGain(pct) * screenMult;
    const eff = deafened ? 0 : baseGain * speakerGain;

    if (isScreenEchoCancelActive() && src === "mic") {
      teardownUserPipe(uid, src);
      try { el.volume = 0; } catch { /* ignore */ }
      try { el.muted = !!deafened; } catch { /* ignore */ }
      try { el.pause(); } catch { /* ignore */ }
      syncScreenEchoVoiceRef();
      return;
    }

    let direct = directStreamByKey.get(pk);
    if (!direct) {
      try {
        const so = el.srcObject;
        if (so instanceof MediaStream) {
          direct = so;
          directStreamByKey.set(pk, direct);
        }
      } catch {
        /* ignore */
      }
    }

    const pipe = audioPipeByKey.get(pk);
    if (pipe?.destNode) teardownUserPipe(uid, src);

    // 0–100%: прямой <audio>.volume — надёжно с setSinkId в Electron.
    if (baseGain <= 1.0) {
      if (pipe?.mediaElementSource) {
        el = replaceAudioElement(uid, src);
      }
      if (direct) {
        try { if (el.srcObject !== direct) el.srcObject = direct; } catch { /* ignore */ }
      }
      applyDirectElementVolume(el, eff);
      return;
    }

    if (!direct) {
      applyDirectElementVolume(el, Math.min(1, eff));
      return;
    }

    if (!ensureElementGainPipe(uid, src, el, direct)) {
      applyDirectElementVolume(el, Math.min(1, eff));
      return;
    }

    const gainPipe = audioPipeByKey.get(pk);
    if (gainPipe?.gainNode) {
      try { el.volume = 1; } catch { /* ignore */ }
      try { el.muted = !!deafened; } catch { /* ignore */ }
      try { gainPipe.gainNode.gain.value = eff; } catch { /* ignore */ }
      void syncPlaybackOutputDevice();
      try { ensurePlaybackAudioCtx()?.resume?.(); } catch { /* ignore */ }
      el.play?.().catch(() => {});
      stabilizeMicAfterPlaybackGraphChange();
    }
  }

  function refreshAllRemoteVoiceVolumesAfterScreenShareToggle() {
    try {
      audioElByUserId.forEach((_el, key) => {
        const idx = String(key).indexOf(":");
        const uid = idx >= 0 ? String(key).slice(0, idx) : String(key);
        const src = idx >= 0 ? String(key).slice(idx + 1) : "mic";
        applyUserVolume(uid, src);
      });
      syncScreenEchoVoiceRef();
    } catch {
      /* ignore */
    }
  }

  async function sfuConsumeProducer(producerId) {
    if (!device || !recvTransport) return;
    const pid0 = String(producerId || "");
    if (!pid0) return;
    if (consumedProducerIds.has(pid0)) return;
    if (consumeInFlight.has(pid0)) return;
    consumeInFlight.add(pid0);
    try {
    const res = await sfuRequest("consume", {
      transportId: recvTransport.id,
      producerId: pid0,
      rtpCapabilities: device.rtpCapabilities
    });
    const cp = res.consumerParameters;
    const consumer = await recvTransport.consume(cp);
    consumers.set(consumer.id, consumer);
    consumedProducerIds.add(pid0);

    consumer.on("transportclose", () => {
      if (destroyed) return;
      const prodId = String(pid0);
      const meta = producerMetaById.get(prodId) || {};
      if (consumer.kind === "audio") {
        const uid = String(meta.userId || consumer.appData?.remoteUserId || "");
        const src = String(meta.source || consumer.appData?.source || "mic");
        if (uid) {
          teardownUserPipe(uid, src);
          removeRemoteAudioByUserAndSource(uid, src);
          try {
            const ds = directStreamByKey.get(pipeKey(uid, src));
            const tr0 = ds?.getAudioTracks?.()?.[0];
            const trc = consumer.track;
            if (trc && tr0 && tr0.id === trc.id) {
              directStreamByKey.delete(pipeKey(uid, src));
            }
          } catch {
            /* ignore */
          }
        }
      }
      try { consumers.delete(consumer.id); } catch { /* ignore */ }
      consumedProducerIds.delete(prodId);
      producerMetaById.delete(prodId);
    });

    const remoteUserId = String(cp?.appData?.remoteUserId || "");
    const source = cp?.appData?.source ? String(cp.appData.source) : "";
    if (producerId && remoteUserId) producerMetaById.set(String(producerId), { userId: remoteUserId, source });

    if (consumer.track?.kind === "audio") {
      const uid = String(remoteUserId);
      const src = source || "mic";
      const el = makeAudioEl(remoteUserId || "unknown", src);
      audioElByUserId.set(`${uid}:${src}`, el);
      // Default behavior (stable): attach track directly.
      const directStream = new MediaStream([consumer.track]);
      directStreamByKey.set(pipeKey(uid, src), directStream);

      // If this user already uses WebAudio pipe, keep pipe and update its source.
      if (!updateUserPipeSource(uid, src, directStream, el)) {
        el.srcObject = directStream;
      }
      el.muted = !!deafened;
      if (!deafened && el.muted) el.muted = false;
      trySetSink(el).catch(() => {});
      applyUserVolume(uid, src);
      if (!(isScreenEchoCancelActive() && src === "mic")) {
        el.play?.().catch(() => {});
      }
      tryStartSpeakingMeter();
      if (src === "mic") syncScreenEchoVoiceRef();

      consumer.track.onunmute = () => {
        try {
          const ds = new MediaStream([consumer.track]);
          directStreamByKey.set(pipeKey(uid, src), ds);
          if (!updateUserPipeSource(uid, src, ds, el)) {
            el.srcObject = ds;
          }
        } catch {
          /* ignore */
        }
        tryPlayAllRemoteMedia();
      };
      consumer.track.onended = () => {
        try {
          teardownUserPipe(uid, src);
          removeRemoteAudioByUserAndSource(uid, src);
          try {
            const ds = directStreamByKey.get(pipeKey(uid, src));
            const tr = ds?.getAudioTracks?.()?.[0];
            if (tr && consumer.track && tr.id === consumer.track.id) {
              directStreamByKey.delete(pipeKey(uid, src));
            }
          } catch {
            /* ignore */
          }
          consumedProducerIds.delete(pid0);
          consumers.delete(consumer.id);
          try { producerMetaById.delete(pid0); } catch { /* ignore */ }
          try { consumer.close?.(); } catch { /* ignore */ }
        } catch {
          /* ignore */
        }
        resyncRemoteProducers("consumer-track-ended").catch(() => {});
      };
    } else if (consumer.track?.kind === "video") {
      const el = makeVideoEl(remoteUserId || "unknown", source || "video");
      el.srcObject = new MediaStream([consumer.track]);
      el.play?.().catch(() => {});
      if (source === "screen") {
        const uid = String(remoteUserId || "");
        consumer.track.onended = () => {
          setState((prev) => ({
            ...prev,
            screenShareUserIds: (prev.screenShareUserIds || []).filter((x) => String(x) !== uid)
          }));
          closeViewerForPeer(uid);
        };
        setState((prev) => ({
          ...prev,
          screenShareUserIds: Array.from(new Set([...(prev.screenShareUserIds || []), String(remoteUserId)]))
        }));
      }
    }

    await sfuRequest("resumeConsumer", { consumerId: consumer.id });
    } finally {
      consumeInFlight.delete(pid0);
    }
  }

  async function restartSfuTransportIce(transport) {
    try {
      if (!transport || transport.closed) return false;
      if (!isSfuSignalingOpen()) return false;
      const res = await sfuRequest("restartIce", { transportId: transport.id });
      const iceParameters = res?.iceParameters;
      if (!iceParameters) return false;
      await transport.restartIce({ iceParameters });
      return true;
    } catch {
      return false;
    }
  }

  async function restartBothSfuTransportsIce(reason) {
    if (destroyed) return false;
    const sendOk = await restartSfuTransportIce(sendTransport);
    const recvOk = await restartSfuTransportIce(recvTransport);
    tryPlayAllRemoteMedia();
    await resumePausedAudioConsumers();
    await refreshAllRemoteAudioConsumers(`ice-restart:${reason}`);
    return sendOk || recvOk;
  }

  function stopSfuWsPing() {
    if (sfuWsPingTimer) {
      clearInterval(sfuWsPingTimer);
      sfuWsPingTimer = null;
    }
  }

  function startSfuWsPing() {
    stopSfuWsPing();
    lastSfuPongAt = Date.now();
    sfuWsPingTimer = setInterval(() => {
      try {
        if (destroyed) return;
        if (!isSfuSignalingOpen()) return;
        if (Date.now() - lastSfuPongAt > 95000) {
          void recoverFromSignalingDrop("ping-timeout").catch(() => {});
          return;
        }
        sfuSend({ type: "ping" });
      } catch {
        /* ignore */
      }
    }, 22000);
  }

  async function teardownLocalSfuMediaForReconnect() {
    if (recvTransportRecoveryTimer) {
      clearTimeout(recvTransportRecoveryTimer);
      recvTransportRecoveryTimer = null;
    }
    stopAudioCtxKeepAlive();
    sfuSignaling.rejectAll("sfu_reconnect");

    stopPlaybackHeal();
    stopSfuWsPing();
    try {
      for (const c of consumers.values()) {
        try {
          c.close?.();
        } catch {
          /* ignore */
        }
      }
    } catch {
      /* ignore */
    }
    consumers.clear();
    consumedProducerIds.clear();
    producerMetaById.clear();

    reconnectPreserve.screen = !!(
      screenProducer
      && screenStream?.getVideoTracks?.()?.[0]?.readyState === "live"
    );
    reconnectPreserve.camera = !!(
      camProducer
      && camStream?.getVideoTracks?.()?.[0]?.readyState === "live"
    );

    const closeProducerQuiet = async (prod) => {
      if (!prod) return;
      const pid = prod?.id ? String(prod.id) : "";
      try {
        if (pid) await sfuRequest("closeProducer", { producerId: pid });
      } catch {
        /* ignore */
      }
      try { prod.close?.(); } catch { /* ignore */ }
    };
    const closing = [
      closeProducerQuiet(micProducer),
      closeProducerQuiet(screenProducer),
      closeProducerQuiet(screenAudioProducer),
      closeProducerQuiet(camProducer),
    ];
    micProducer = null;
    micProducedTrack = null;
    screenProducer = null;
    screenAudioProducer = null;
    camProducer = null;
    await Promise.all(closing);

    try {
      sendTransport?.close?.();
    } catch {
      /* ignore */
    }
    try {
      recvTransport?.close?.();
    } catch {
      /* ignore */
    }
    sendTransport = null;
    recvTransport = null;
    device = null;

    try {
      audioPipeByKey.forEach((p) => {
        stopBoostTrack(p);
        try { p?.srcNode?.disconnect?.(); } catch { /* ignore */ }
        try { p?.mediaElementSource?.disconnect?.(); } catch { /* ignore */ }
        try { p?.gainNode?.disconnect?.(); } catch { /* ignore */ }
      });
    } catch {
      /* ignore */
    }
    audioPipeByKey.clear();
    directStreamByKey.clear();
    audioElByUserId.clear();
    releaseAllRosterMeterClones();
    try {
      if (playbackAudioCtx && playbackAudioCtx.state !== "closed") playbackAudioCtx.close?.();
    } catch { /* ignore */ }
    playbackAudioCtx = null;
    playbackLimiterNode = null;
    try {
      remoteAudioHost?.querySelectorAll?.('[id^="sfu-remote-audio-"]')?.forEach?.((el) => {
        try {
          el.remove?.();
        } catch {
          /* ignore */
        }
      });
    } catch {
      /* ignore */
    }
    try {
      (remoteVideoHost || document.querySelector(".voice-video-stage"))
        ?.querySelectorAll?.('[id^="remote-video-"]')
        ?.forEach?.((el) => {
          try {
            el.remove?.();
          } catch {
            /* ignore */
          }
        });
    } catch {
      /* ignore */
    }
    try {
      speakingAnalysers.delete(String(selfUserId));
    } catch {
      /* ignore */
    }
  }

  function consumerHealthyForProducer(producerId) {
    const pid = String(producerId || "");
    if (!pid) return false;
    const rx = recvTransport?.connectionState;
    if (!recvTransport || recvTransport.closed || rx === "failed" || rx === "disconnected") return false;
    for (const c of consumers.values()) {
      if (String(c.producerId) !== pid) continue;
      if (c.closed || c.paused) return false;
      if (c.kind === "audio") {
        const tr = c.track;
        return !!(tr && String(tr.readyState) === "live");
      }
      return true;
    }
    return false;
  }

  function transportsLookAlive() {
    return !!(
      sendTransport
      && recvTransport
      && !sendTransport.closed
      && !recvTransport.closed
      && device
    );
  }

  async function tryLightweightRecovery(reason) {
    if (destroyed) return false;
    if (!isSfuSignalingOpen()) return false;
    if (!transportsLookAlive()) return false;
    try {
      voiceFsm.transition("recovering", `light-${String(reason || "recover")}`);
      await restartBothSfuTransportsIce(String(reason || "recover"));
      await resumePausedAudioConsumers();
      await refreshAllRemoteAudioConsumers(`light-${String(reason || "recover")}`);
      tryPlayAllRemoteMedia();
      voiceFsm.transition("connected", `light-${String(reason || "recover")}-ok`);
      setState((prev) => ({ ...prev, mediaLinkReady: true }));
      return true;
    } catch {
      voiceFsm.markRecoveryFailed(`light-${String(reason || "recover")}`);
      return false;
    }
  }

  async function recoverAfterPresenceReconnect() {
    if (destroyed) return;
    if (!presenceClient?.isGatewayReady()) {
      await rebuildSfuMediaAfterSignalingDrop("presence-reconnect", false, true);
      return;
    }
    if (await tryLightweightRecovery("presence-reconnect")) return;
    await rebuildSfuMediaAfterSignalingDrop("presence-reconnect", false, true);
  }

  async function recoverFromSignalingDrop(reason, skipGatewayReconnect = false) {
    if (destroyed) return;
    const r = String(reason || "recover");
    if (r === "ws-close" || r === "bridge-refreshed") {
      await rebuildSfuMediaAfterSignalingDrop(r, false, skipGatewayReconnect);
      return;
    }
    if (await tryLightweightRecovery(r)) return;
    await rebuildSfuMediaAfterSignalingDrop(r, false, skipGatewayReconnect);
  }

  async function rebuildSfuMediaAfterSignalingDrop(reason, isRetry = false, skipGatewayReconnect = false) {
    if (destroyed) return;
    if (sfuMediaRebuildInFlight) {
      sfuPendingRebuildReason = String(reason || "rebuild");
      sfuPendingRebuildSkipGateway = !!skipGatewayReconnect;
      return;
    }
    clearSfuRebuildRetryTimer();
    sfuMediaRebuildInFlight = true;
    voiceFsm.transition("recovering", String(reason || "rebuild"));
    try {
      await applyFreshSfuCredentials(skipGatewayReconnect);
      await teardownLocalSfuMediaForReconnect();
      if (!useVoiceGateway) {
        try {
          sfuWs?.close?.();
        } catch {
          /* ignore */
        }
        sfuWs = null;
      }
      await startSfuClient();
      await restoreLocalProducersAfterReconnect();
      voiceFsm.transition("connected", `${String(reason || "rebuild")}-ok`);
      setState((prev) => ({ ...prev, mediaLinkReady: true }));
    } catch {
      voiceFsm.markRecoveryFailed(String(reason || "rebuild"));
      if (!destroyed && !isRetry) {
        sfuPendingRebuildRetryTimer = setTimeout(() => {
          sfuPendingRebuildRetryTimer = null;
          if (destroyed) return;
          void rebuildSfuMediaAfterSignalingDrop(`${String(reason)}-retry`, true, skipGatewayReconnect).catch(() => {});
        }, 2000);
      }
    } finally {
      sfuMediaRebuildInFlight = false;
      if (sfuPendingRebuildReason && !destroyed) {
        const pendingReason = sfuPendingRebuildReason;
        const pendingSkip = sfuPendingRebuildSkipGateway;
        sfuPendingRebuildReason = null;
        sfuPendingRebuildSkipGateway = false;
        void rebuildSfuMediaAfterSignalingDrop(pendingReason, false, pendingSkip).catch(() => {});
      }
    }
  }

  mediaRebuildFn = rebuildSfuMediaAfterSignalingDrop;

  async function restoreLocalProducersAfterReconnect() {
    if (destroyed) return;
    try {
      await startMicIfNeeded();
      await applyMicCaptureStream(localMicStream);
    } catch {
      /* ignore */
    }
    try {
      if (reconnectPreserve.camera && camStream && !camProducer) {
        const track = camStream.getVideoTracks?.()?.[0];
        if (track && track.readyState === "live" && sendTransport) {
          camProducer = await sendTransport.produce({ track, appData: { source: "camera" } });
        }
      }
    } catch {
      /* ignore */
    }
    try {
      if (reconnectPreserve.screen && screenStream && !screenProducer) {
        const vtrack = screenStream.getVideoTracks?.()?.[0];
        if (vtrack && vtrack.readyState === "live" && sendTransport) {
          screenProducer = await sendTransport.produce({
            track: vtrack,
            encodings: [{ maxBitrate: screenShareState.maxBitrate, maxFramerate: screenShareState.fps }],
            appData: { source: "screen" },
          });
          let atrack = screenAudioCaptureTrack;
          if (!atrack || atrack.readyState === "ended") {
            atrack = screenStream.getAudioTracks?.()?.[0] || null;
          }
          if (atrack && atrack.readyState === "live") {
            screenAudioProducer = await sendTransport.produce({
              track: atrack,
              appData: { source: "screenAudio" },
            });
          }
          sendPresence({ type: "screenShare", roomId, enabled: true });
          setState((prev) => ({
            ...prev,
            sharingScreen: true,
            screenShareUserIds: Array.from(new Set([...(prev.screenShareUserIds || []), String(selfUserId)])),
          }));
        }
      }
    } catch {
      /* ignore */
    }
    reconnectPreserve.screen = false;
    reconnectPreserve.camera = false;
  }

  function installNetworkRecovery() {
    if (networkRecoveryHandlers) return;
    const onOnline = () => {
      if (destroyed) return;
      voiceFsm.transition("recovering", "online");
      setState((prev) => ({ ...prev, mediaLinkReady: false }));
      if (useVoiceGateway) {
        const sock = presenceClient?.getSocket();
        if (!sock || sock.readyState !== WebSocket.OPEN) {
          void presenceClient?.connect().catch(() => {});
          return;
        }
        if (!presenceClient?.isGatewayReady()) {
          void recoverAfterPresenceReconnect().catch(() => {});
          return;
        }
      } else if (!isSfuSignalingOpen()) {
        void recoverFromSignalingDrop("online").catch(() => {});
        return;
      }
      void restartBothSfuTransportsIce("online").catch(() => {});
      tryPlayAllRemoteMedia();
      voiceFsm.transition("connected", "online");
      setState((prev) => ({ ...prev, mediaLinkReady: true }));
    };
    const onOffline = () => {
      if (destroyed) return;
      voiceFsm.transition("degraded", "offline");
      setState((prev) => ({ ...prev, mediaLinkReady: false }));
    };
    const onConnectionChange = () => {
      if (destroyed) return;
      if (connectionChangeDebounce) clearTimeout(connectionChangeDebounce);
      connectionChangeDebounce = setTimeout(() => {
        connectionChangeDebounce = null;
        if (destroyed) return;
        const tx = String(sendTransport?.connectionState || "");
        const rx = String(recvTransport?.connectionState || "");
        if (tx !== "failed" && tx !== "disconnected" && rx !== "failed" && rx !== "disconnected") return;
        void tryLightweightRecovery("connection-change").catch(() => {});
      }, 3000);
    };
    window.addEventListener("online", onOnline);
    window.addEventListener("offline", onOffline);
    const conn = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
    if (conn) {
      try { conn.addEventListener("change", onConnectionChange); } catch { /* ignore */ }
    }
    networkRecoveryHandlers = { onOnline, onOffline, onConnectionChange, conn };
  }

  function uninstallNetworkRecovery() {
    if (!networkRecoveryHandlers) return;
    try { window.removeEventListener("online", networkRecoveryHandlers.onOnline); } catch { /* ignore */ }
    try { window.removeEventListener("offline", networkRecoveryHandlers.onOffline); } catch { /* ignore */ }
    if (networkRecoveryHandlers.conn) {
      try {
        networkRecoveryHandlers.conn.removeEventListener("change", networkRecoveryHandlers.onConnectionChange);
      } catch { /* ignore */ }
    }
    networkRecoveryHandlers = null;
  }

  async function refreshAllRemoteAudioConsumers(reason) {
    if (destroyed) return;
    if (!isSfuSignalingOpen() || !device || !recvTransport) return;
    const audioPids = new Set();
    for (const c of consumers.values()) {
      if (!c || c.closed || c.kind !== "audio") continue;
      const pid = String(c.producerId || "");
      if (pid) audioPids.add(pid);
    }
    for (const pid of audioPids) {
      const meta = producerMetaById.get(pid) || {};
      releaseLocalSfuAudioConsumerByProducerId(pid, meta.userId, meta.source);
    }
    await resyncRemoteProducers(String(reason || "refresh-audio"));
  }

  async function resyncRemoteProducers(reason) {
    if (resyncRemoteProducersInFlight) {
      resyncRemoteProducersQueued = true;
      return;
    }
    resyncRemoteProducersInFlight = true;
    try {
      if (destroyed) return;
      if (!isSfuSignalingOpen()) return;
      if (!device || !recvTransport) return;
      const prod = await sfuRequest("getProducers");
      for (const it of prod.items || []) {
        const pid = String(it.producerId || "");
        if (!pid) continue;
        if (consumedProducerIds.has(pid)) {
          if (consumerHealthyForProducer(pid)) continue;
          releaseLocalSfuAudioConsumerByProducerId(pid);
        }
        sfuConsumeProducer(pid).catch(() => {});
      }
      tryPlayAllRemoteMedia();
    } catch {
      // ignore
    } finally {
      resyncRemoteProducersInFlight = false;
      if (resyncRemoteProducersQueued) {
        resyncRemoteProducersQueued = false;
        void resyncRemoteProducers(String(reason || "queued"));
      }
    }
  }

  async function startMicIfNeeded() {
    if (localMicStream) return localMicStream;
    // Keep currentInputDeviceId in sync even for default device.
    if (currentInputDeviceId == null) currentInputDeviceId = "";
    localMicStream = await navigator.mediaDevices.getUserMedia({
      audio: buildAudioConstraints(currentInputDeviceId || "")
    });
    try {
      rawMicCaptureTrack = localMicStream?.getAudioTracks?.()[0] || null;
    } catch {
      rawMicCaptureTrack = null;
    }
    tryStartSpeakingMeter();
    return localMicStream;
  }

  async function startCamera() {
    if (camProducer) return;
    camStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
    const track = camStream.getVideoTracks()[0];
    if (!track) return;
    camProducer = await sendTransport.produce({ track, appData: { source: "camera" } });
  }

  async function stopCamera() {
    try {
      if (camProducer?.id) {
        await sfuRequest("closeProducer", { producerId: String(camProducer.id) });
      }
    } catch {
      // ignore
    }
    try { camProducer?.close?.(); } catch { /* ignore */ }
    camProducer = null;
    try { camStream?.getTracks?.().forEach((t) => t.stop()); } catch { /* ignore */ }
    camStream = null;
  }

  async function startScreen() {
    if (screenProducer) return;
    if (!navigator.mediaDevices.getDisplayMedia) throw new Error("Демонстрация экрана не поддерживается на этом устройстве");
    const electronPicker = !!window.sloncord?.takeDisplayCaptureProfile;
    try {
      if (electronPicker) {
        // Electron: video only from getDisplayMedia; audio is replaced by native WASAPI helper.
        // Request audio so picker shows the checkbox, but ignore Chromium audio track.
        screenStream = await navigator.mediaDevices.getDisplayMedia({ video: { cursor: "motion" }, audio: true });
      } else {
        try {
          screenStream = await navigator.mediaDevices.getDisplayMedia({
            video: { frameRate: { ideal: 30, max: 60 } },
            audio: buildScreenAudioConstraints(),
          });
        } catch {
          screenStream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: buildScreenAudioConstraints() });
        }
      }
    } catch {
      screenStream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: buildScreenAudioConstraints() });
    }
    const vtrack = screenStream.getVideoTracks()[0];
    if (!vtrack) return;
    if (electronPicker) {
      try { screenStream.getAudioTracks?.().forEach((t) => t.stop()); } catch { /* ignore */ }
    }

    let capProfile: DisplayCaptureProfile | null = null;
    try {
      capProfile = (await window.sloncord?.takeDisplayCaptureProfile?.()) ?? null;
    } catch {
      capProfile = null;
    }
    await applyDisplayCaptureProfileToTrack(vtrack, capProfile);

    let displaySel = null;
    if (electronPicker) {
      try {
        displaySel = (await window.sloncord?.takeDisplaySelection?.()) ?? null;
      } catch {
        displaySel = null;
      }
    }

    try {
      const vt = vtrack as MediaStreamTrack & { contentHint?: string };
      if (capProfile) {
        vt.contentHint = capProfile.frameRate > 35 ? "motion" : "detail";
      } else {
        vt.contentHint = "motion";
      }
    } catch {
      /* ignore */
    }
    vtrack.onended = () => {
      stopScreen().catch(() => {});
    };

    const fps = capProfile?.frameRate ?? 30;
    const maxBitrate = capProfile ? bitrateForScreenShareProfile(capProfile) : 6_000_000;
    screenShareState.fps = fps;
    screenShareState.maxBitrate = maxBitrate;

    screenProducer = await sendTransport.produce({
      track: vtrack,
      encodings: [{ maxBitrate, maxFramerate: fps }],
      appData: { source: "screen" },
    });
    // Screen audio (Electron): use native helper track when available; web uses captured audio.
    try {
      let atrack = electronPicker ? null : (screenStream.getAudioTracks?.()[0] || null);
      if (electronPicker) {
        try {
          await new Promise((r) => setTimeout(r, 0));
          const nativeTr = await startNativeScreenAudioTrack(displaySel);
          if (nativeTr) {
            atrack = nativeTr;
          } else {
            const msg = getLastNativeScreenAudioStartError();
            if (msg) reportScreenAudioError(`Звук демонстрации не запущен: ${msg}`);
          }
        } catch { /* ignore */ }
      }
      if (atrack) {
        screenAudioCaptureTrack = atrack;
        screenAudioProducer = await sendTransport.produce({ track: atrack, appData: { source: "screenAudio" } });
        if (electronPicker && isNativeScreenAudioActive()) {
          await startScreenVoiceEchoRef();
        } else {
          syncScreenEchoVoiceRef();
          refreshAllRemoteVoiceVolumesAfterScreenShareToggle();
        }
      }
    } catch {
      // ignore (audio capture not supported/denied)
    }
    sendPresence({ type: "screenShare", roomId, enabled: true });
    setState((prev) => ({
      ...prev,
      sharingScreen: true,
      screenShareUserIds: Array.from(new Set([...(prev.screenShareUserIds || []), String(selfUserId)]))
    }));
  }

  function stopScreen() {
    const sp = screenProducer;
    const sa = screenAudioProducer;
    const ss = screenStream;
    if (!sp && !sa && !ss) {
      return Promise.resolve();
    }
    const spid = sp?.id ? String(sp.id) : "";
    const said = sa?.id ? String(sa.id) : "";

    screenProducer = null;
    screenAudioProducer = null;
    screenAudioCaptureTrack = null;
    screenStream = null;

    try {
      sp?.close?.();
    } catch {
      /* ignore */
    }
    try {
      sa?.close?.();
    } catch {
      /* ignore */
    }
    try {
      ss?.getTracks?.().forEach((t) => t.stop());
    } catch {
      /* ignore */
    }
    try { void stopScreenVoiceEchoRef(); } catch { /* ignore */ }
    try { void stopNativeScreenAudioTrack(); } catch { /* ignore */ }
    refreshAllRemoteVoiceVolumesAfterScreenShareToggle();

    sendPresence({ type: "screenShare", roomId, enabled: false });
    setState((prev) => ({
      ...prev,
      sharingScreen: false,
      screenShareUserIds: (prev.screenShareUserIds || []).filter((x) => String(x) !== String(selfUserId))
    }));

    if (!spid && !said) {
      return Promise.resolve();
    }
    return (async () => {
      if (spid) {
        try {
          await sfuRequest("closeProducer", { producerId: spid });
        } catch {
          /* ignore */
        }
      }
      if (said) {
        try {
          await sfuRequest("closeProducer", { producerId: said });
        } catch {
          /* ignore */
        }
      }
    })();
  }

  async function replaceScreenShareSfu() {
    if (!screenProducer) return;
    if (!navigator.mediaDevices.getDisplayMedia) {
      throw new Error("Демонстрация экрана не поддерживается на этом устройстве");
    }
    const electronPicker = !!window.sloncord?.takeDisplayCaptureProfile;
    let ds;
    try {
      if (electronPicker) {
        // Keep same request shape as initial startScreen(): ensure cursor motion preset and show audio checkbox.
        ds = await navigator.mediaDevices.getDisplayMedia({ video: { cursor: "motion" }, audio: true });
      } else {
        try {
          ds = await navigator.mediaDevices.getDisplayMedia({
            video: { frameRate: { ideal: 30, max: 60 } },
            audio: true
          });
        } catch {
          ds = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
        }
      }
    } catch {
      ds = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
    }
    const vtrack = ds.getVideoTracks()[0];
    if (!vtrack) {
      try {
        ds.getTracks().forEach((t) => t.stop());
      } catch { /* ignore */ }
      throw new Error("Не удалось получить видеопоток экрана");
    }
    if (electronPicker) {
      try {
        ds.getAudioTracks?.().forEach((t) => t.stop());
      } catch { /* ignore */ }
    }

    let capProfile: DisplayCaptureProfile | null = null;
    try {
      capProfile = (await window.sloncord?.takeDisplayCaptureProfile?.()) ?? null;
    } catch {
      capProfile = null;
    }
    await applyDisplayCaptureProfileToTrack(vtrack, capProfile);

    let displaySel = null;
    if (electronPicker) {
      try {
        displaySel = (await window.sloncord?.takeDisplaySelection?.()) ?? null;
      } catch {
        displaySel = null;
      }
    }

    try {
      const vt = vtrack;
      if (capProfile) {
        vt.contentHint = capProfile.frameRate > 35 ? "motion" : "detail";
      } else {
        vt.contentHint = "motion";
      }
    } catch { /* ignore */ }
    vtrack.onended = () => {
      void stopScreen().catch(() => {});
    };

    let newAudioTrack = null;
    if (electronPicker) {
      try {
        await stopScreenVoiceEchoRef();
        await stopNativeScreenAudioTrack();
        newAudioTrack = (await startNativeScreenAudioTrack(displaySel)) || null;
        if (newAudioTrack) await startScreenVoiceEchoRef();
      } catch {
        newAudioTrack = null;
      }
    } else {
      newAudioTrack = ds.getAudioTracks?.()?.[0] || null;
    }

    if (electronPicker && !newAudioTrack) {
      const msg = getLastNativeScreenAudioStartError();
      if (msg) reportScreenAudioError(`Звук демонстрации не запущен: ${msg}`);
    }

    await new Promise((r) => setTimeout(r, 0));

    const oldStream = screenStream;
    const oldVideo = oldStream?.getVideoTracks?.()?.[0] || null;
    const oldScreenProducer = screenProducer;
    const oldScreenProducerId = oldScreenProducer?.id != null ? String(oldScreenProducer.id) : "";
    const oldScreenAudioProducer = screenAudioProducer;
    const oldScreenAudioProducerId = oldScreenAudioProducer?.id != null ? String(oldScreenAudioProducer.id) : "";

    // IMPORTANT: for screen video we must recreate producer to apply new encodings (fps/bitrate).
    // mediasoup Producer encodings are set on `produce` and don't change with replaceTrack.
    const fps = capProfile?.frameRate ?? 30;
    const maxBitrate = capProfile ? bitrateForScreenShareProfile(capProfile) : 6_000_000;
    screenShareState.fps = fps;
    screenShareState.maxBitrate = maxBitrate;
    try {
      // Close old producers on SFU first (this triggers viewer detach, then refresh on new producer).
      try { oldScreenProducer?.close?.(); } catch { /* ignore */ }
      screenProducer = null;
      if (oldScreenProducerId) {
        try { await sfuRequest("closeProducer", { producerId: oldScreenProducerId }); } catch { /* ignore */ }
      }

      try { oldScreenAudioProducer?.close?.(); } catch { /* ignore */ }
      screenAudioProducer = null;
      if (oldScreenAudioProducerId) {
        try { await sfuRequest("closeProducer", { producerId: oldScreenAudioProducerId }); } catch { /* ignore */ }
      }

      // Create fresh producers with new parameters.
      screenProducer = await sendTransport.produce({
        track: vtrack,
        encodings: [{ maxBitrate, maxFramerate: fps }],
        appData: { source: "screen" }
      });
      if (newAudioTrack) {
        screenAudioProducer = await sendTransport.produce({
          track: newAudioTrack,
          appData: { source: "screenAudio" }
        });
      }
    } catch (e) {
      try { ds.getTracks().forEach((t) => t.stop()); } catch { /* ignore */ }
      throw e;
    }

    try {
      oldVideo?.stop?.();
    } catch { /* ignore */ }
    if (oldStream) {
      try {
        oldStream.getAudioTracks?.().forEach((t) => t.stop());
      } catch { /* ignore */ }
    }
    screenStream = ds;
  }

  async function startSfuClient() {
    const ms = await loadMediasoupClient();

    if (useVoiceGateway) {
      if (!presenceClient?.isGatewayReady()) throw new Error("SFU gateway не готов");
    } else {
      // Свежий JWT только в rebuild (там уже вызван applyFresh). Повторный /voice/sfuToken на каждом startSfuClient
      // давал лишние запросы и риск гонок; не трогаем liveSfuUrl/liveSfuToken при обычном join.
      let finalUrl = String(liveSfuUrl || "");
      if (!liveSfuUrl || !liveSfuToken) throw new Error("SFU параметры не получены");
      if (!/token=/.test(finalUrl)) {
        const sep = finalUrl.includes("?") ? "&" : "?";
        finalUrl = `${finalUrl}${sep}token=${encodeURIComponent(String(liveSfuToken || ""))}`;
      }

      await new Promise((resolve, reject) => {
        const ws = new WebSocket(finalUrl);
        const timer = setTimeout(() => {
          try { ws.close(); } catch { /* ignore */ }
          reject(new Error("SFU WS timeout"));
        }, 8000);
        ws.onopen = () => {
          clearTimeout(timer);
          sfuWs = ws;
          resolve();
        };
        ws.onerror = () => {
          clearTimeout(timer);
          reject(new Error("SFU WS error"));
        };
      });

      sfuWs.onmessage = async (ev) => {
        let msg;
        try { msg = JSON.parse(ev.data); } catch { return; }
        await handleSfuInboundMessage(msg);
      };

      sfuWs.onclose = () => {
        if (destroyed || sfuMediaRebuildInFlight) return;
        void recoverFromSignalingDrop("ws-close").catch(() => {});
      };
      sfuWs.onerror = () => {
        /* onclose usually follows; if not, ping-timeout will recover */
      };
    }

    const transports = await createMediasoupTransports(ms, sfuRequest, iceServersList, {
      onSendState: (state) => {
        if (state !== "failed" && state !== "disconnected") return;
        if (destroyed) return;
        void restartBothSfuTransportsIce(`send-${state}`).catch(() => {});
      },
      onRecvState: (state) => {
        if (state === "connected") {
          try { audioCtx?.resume?.().catch(() => {}); } catch { /* ignore */ }
          tryPlayAllRemoteMedia();
          void resumePausedAudioConsumers().catch(() => {});
          resyncRemoteProducers("recv-connected").catch(() => {});
        }
        if (state !== "failed" && state !== "disconnected") return;
        if (recvTransportRecoveryTimer) clearTimeout(recvTransportRecoveryTimer);
        recvTransportRecoveryTimer = setTimeout(() => {
          recvTransportRecoveryTimer = null;
          if (destroyed) return;
          void (async () => {
            await restartBothSfuTransportsIce(`recv-${state}`);
            tryPlayAllRemoteMedia();
          })().catch(() => {});
        }, state === "failed" ? 0 : 600);
      },
    });
    device = transports.device;
    sendTransport = transports.sendTransport;
    recvTransport = transports.recvTransport;

    // Produce mic first (fast join).
    await startMicIfNeeded();
    await applyMicCaptureStream(localMicStream);

    // Consume existing producers.
    const prod = await sfuRequest("getProducers");
    for (const it of prod.items || []) {
      sfuConsumeProducer(String(it.producerId)).catch(() => {});
    }

    // Autoplay may be blocked after reload until a user gesture.
    // Install unlock handler and attempt play immediately.
    installGestureMediaUnlock();
    installSfuVisibilityRecovery();
    tryPlayAllRemoteMedia();
    startPlaybackHeal();
    startAudioCtxKeepAlive();

    // If we are connected but accidentally missed remote producers, resync a few times.
    try {
      setTimeout(() => resyncRemoteProducers("post-join-2s"), 2000);
      setTimeout(() => resyncRemoteProducers("post-join-5s"), 5000);
      setTimeout(() => resyncRemoteProducers("post-join-9s"), 9000);
    } catch {
      // ignore
    }

    startSfuWsPing();
  }

  return {
    async join() {
      voiceFsm.transition("joining", "join");
      setState({ joining: true, connected: false, room: roomId });
      if (useVoiceGateway) {
        await presenceClient.connect();
        await startSfuClient();
      } else {
        await Promise.all([presenceClient.connect(), startSfuClient()]);
      }
      installNetworkRecovery();
      startCredentialRefreshTimer();
      voiceFsm.transition("connected", "join-ok");
      setState({ joining: false, connected: true, mediaLinkReady: true, room: roomId, peers: Math.max(0, (lastRoster || []).length - 1) });
      // Apply persisted prefs immediately after join.
      try { applyLocalMuteDeafen(); } catch { /* ignore */ }
    },

    toggleMute() {
      micEnabledWanted = !micEnabledWanted;
      applyLocalMuteDeafen();
    },

    toggleDeafen() {
      deafened = !deafened;
      applyLocalMuteDeafen();
    },

    toggleScreenShare() {
      if (screenProducer) {
        void stopScreen().catch(() => {});
        return;
      }
      return startScreen();
    },

    async reconfigureScreenShare() {
      if (!screenProducer) return;
      await replaceScreenShareSfu();
    },

    async toggleCamera() {
      if (camProducer) await stopCamera();
      else await startCamera();
    },

    async setInputDevice(deviceId) {
      try {
        const did = String(deviceId || "");
        currentInputDeviceId = did;
        const s = await navigator.mediaDevices.getUserMedia({
          audio: buildAudioConstraints(did),
          video: false
        });
        await applyMicCaptureStream(s);
      } catch {
        // ignore
      }
    },

    async setOutputDevice(deviceId) {
      outputDeviceId = String(deviceId || "");
      try {
        remoteAudioHost?.querySelectorAll?.("audio")?.forEach?.((el) => {
          trySetSink(el).catch(() => {});
        });
      } catch {
        // ignore
      }
      try {
        await syncPlaybackOutputDevice();
      } catch {
        /* ignore */
      }
      try {
        await screenVoiceEchoRef?.setOutputDevice?.(outputDeviceId);
      } catch {
        /* ignore */
      }
      if (isScreenEchoCancelActive()) {
        silenceMicPlaybackForScreenEcho();
        syncScreenEchoVoiceRef();
      }
      refreshAllRemoteVoiceVolumesAfterScreenShareToggle();
    },

    setMicGain(v) {
      const x = Math.max(0, Math.min(100, Number(v) || 0));
      micGain = x / 100;
      try {
        if (micGainNode) micGainNode.gain.value = micGain;
      } catch {
        // ignore
      }
    },

    async setAdvancedNoiseSuppression(enabled) {
      advancedNs = !!enabled;
      // Re-acquire mic and replace track best-effort (only if we already have producer).
      try {
        if (!micProducer) return;
        await this.setInputDevice(currentInputDeviceId || "");
      } catch {
        // ignore
      }
    },

    setAudioProcessing(opts) {
      const nextEc = opts?.echoCancellation != null ? !!opts.echoCancellation : echoCancellation;
      const nextNs = opts?.noiseSuppression != null ? !!opts.noiseSuppression : noiseSuppression;
      const nextAgc = opts?.autoGainControl != null ? !!opts.autoGainControl : autoGainControl;
      const nextNsLevel = opts?.noiseSuppressionLevel != null
        ? Math.max(0, Math.min(100, Number(opts.noiseSuppressionLevel) || 0))
        : noiseSuppressionLevel;
      const nextAuto = opts?.inputSensitivityAuto != null ? !!opts.inputSensitivityAuto : inputSensitivityAuto;
      const nextSens = opts?.inputSensitivity != null ? (Number(opts?.inputSensitivity) || inputSensitivity) : inputSensitivity;
      const nextAdv = nextNs && Number(nextNsLevel) >= 70;
      const prevChain = !!noiseSuppression && Number(noiseSuppressionLevel) >= 45;
      const nextChain = nextNs && Number(nextNsLevel) >= 45;
      const captureChanged =
        nextEc !== echoCancellation
        || nextNs !== noiseSuppression
        || nextAgc !== autoGainControl
        || nextAdv !== advancedNs
        || nextNsLevel !== noiseSuppressionLevel
        || prevChain !== nextChain;
      const filterChanged = nextNsLevel !== noiseSuppressionLevel || nextNs !== noiseSuppression;
      echoCancellation = nextEc;
      noiseSuppression = nextNs;
      autoGainControl = nextAgc;
      advancedNs = nextAdv;
      noiseSuppressionLevel = nextNsLevel;
      inputSensitivityAuto = nextAuto;
      inputSensitivity = nextSens;

      try {
        if (captureChanged && (micProducer || localMicStream)) {
          this.setInputDevice(currentInputDeviceId || "").catch(() => {});
        } else if (filterChanged && (micProducer || localMicStream) && localMicStream) {
          const raw = rawMicCaptureTrack || localMicStream.getAudioTracks?.()?.[0];
          if (raw && raw.readyState !== "ended") {
            rebuildMicWebAudioChain(raw).then((nextTrack) => {
              if (!nextTrack || !micProducer || micProducer.closed) return;
              nextTrack.enabled = !effectiveMuted();
              micProducedTrack = nextTrack;
              return micProducer.replaceTrack?.({ track: nextTrack });
            }).catch(() => {});
          }
        } else {
          ensureMicTransmitGain();
        }
      } catch { /* ignore */ }
    },

    getAudioProcessingInfo() {
      const t = rawMicCaptureTrack || localMicStream?.getAudioTracks?.()?.[0] || null;
      let settings = null;
      try { settings = t?.getSettings?.() || null; } catch { settings = null; }
      const level = Number(noiseSuppressionLevel) || 0;
      const parts = [];
      if (echoCancellation) parts.push("эхо");
      if (noiseSuppression && level > 0) parts.push(`шум ${level}%`);
      if (autoGainControl) parts.push("AGC");
      const applied = [];
      if (settings && typeof settings.echoCancellation === "boolean") {
        applied.push(`эхо ${settings.echoCancellation ? "вкл" : "выкл"}`);
      }
      if (settings && typeof settings.noiseSuppression === "boolean") {
        applied.push(`шум ${settings.noiseSuppression ? "вкл" : "выкл"}`);
      }
      if (settings && typeof settings.autoGainControl === "boolean") {
        applied.push(`AGC ${settings.autoGainControl ? "вкл" : "выкл"}`);
      }
      const summary = [
        parts.length ? `В канал: ${parts.join(", ")}` : "В канал: без обработки",
        applied.length ? `Микрофон: ${applied.join(", ")}` : null
      ].filter(Boolean).join(" · ");
      return {
        summary,
        requested: {
          echoCancellation: !!echoCancellation,
          noiseSuppression: !!noiseSuppression,
          autoGainControl: !!autoGainControl,
          noiseSuppressionLevel: level
        },
        applied: settings
      };
    },

    getInputMeter() {
      const live = readAnalyserRms(micMeterAnalyser);
      const instant = Math.max(Number(lastLocalRms) || 0, live);
      const smoothed = Number(lastLocalMeterRms) || 0;
      return {
        rms: Math.max(instant, smoothed),
        threshold: Number(lastLocalThreshold) || 0.006,
        open: !!lastLocalMicSpeaking,
        auto: !!inputSensitivityAuto
      };
    },

    ensurePlayback() {
      tryPlayAllRemoteMedia();
      try { audioCtx?.resume?.().catch(() => {}); } catch { /* ignore */ }
      startPlaybackHeal();
    },

    getVoiceMetrics() {
      return voiceFsm.getMetrics();
    },

    setSpeakerGain(v) {
      const x = Math.max(0, Math.min(100, Number(v) || 0));
      speakerGain = x / 100;
      try {
        audioElByUserId.forEach((_, key) => {
          const [uid, src] = String(key).split(":");
          applyUserVolume(uid, src || "mic");
        });
      } catch { /* ignore */ }
    },

    setUserVolume(userId, v) {
      const x = Math.max(0, Math.min(300, Number(v) || 0));
      const targets = listMicPlaybackTargets(userId);
      if (targets.size) {
        for (const { uid } of targets.values()) userVolumePctByUserId.set(String(uid), x);
      } else {
        userVolumePctByUserId.set(String(userId || ""), x);
      }
      const applyList = targets.size
        ? [...targets.values()]
        : [{ uid: String(userId || ""), src: "mic" }];
      for (const { uid, src } of applyList) applyUserVolume(uid, src, x);
    },

    setScreenAudioVolume(userId, v) {
      const uid = String(userId || "");
      const x = Math.max(0, Math.min(300, Number(v) || 0));
      screenAudioPctByUserId.set(uid, x);
      applyUserVolume(uid, "screenAudio");
    },

    destroy() {
      if (destroyed) return;
      clearSfuRebuildRetryTimer();
      uninstallNetworkRecovery();
      destroyed = true;

      // Mobile Safari: aggressively stop and remove media elements to avoid audio artifacts after leaving voice.
      try {
        remoteAudioHost?.querySelectorAll?.("audio")?.forEach?.((el) => {
          try { el.pause?.(); } catch { /* ignore */ }
          try { el.srcObject = null; } catch { /* ignore */ }
          try { el.remove?.(); } catch { /* ignore */ }
        });
      } catch { /* ignore */ }
      try {
        (remoteVideoHost || document.querySelector(".voice-video-stage"))?.querySelectorAll?.("video")?.forEach?.((el) => {
          try { el.pause?.(); } catch { /* ignore */ }
          try { el.srcObject = null; } catch { /* ignore */ }
          try { el.remove?.(); } catch { /* ignore */ }
        });
      } catch { /* ignore */ }

      stopCredentialRefreshTimer();
      try { sendPresence({ type: "setSpeaking", roomId, speaking: false }); } catch { /* ignore */ }
      try { presenceClient?.close(); } catch { /* ignore */ }
      sfuSignaling.rejectAll("destroy");

      try {
        if (micProducer?.id) {
          sfuRequest("closeProducer", { producerId: String(micProducer.id) }).catch(() => {});
        }
      } catch {
        // ignore
      }
      try { micProducer?.close?.(); } catch { /* ignore */ }
      micProducer = null;
      stopCamera().catch(() => {});
      stopScreen().catch(() => {});

      try { sendTransport?.close?.(); } catch { /* ignore */ }
      try { recvTransport?.close?.(); } catch { /* ignore */ }
      sendTransport = null;
      recvTransport = null;

      for (const c of consumers.values()) {
        try { c.close?.(); } catch { /* ignore */ }
      }
      consumers.clear();
      consumedProducerIds.clear();
      audioElByUserId.clear();
      try {
        audioPipeByKey.forEach((p) => {
          stopBoostTrack(p);
          try { p?.srcNode?.disconnect?.(); } catch { /* ignore */ }
          try { p?.mediaElementSource?.disconnect?.(); } catch { /* ignore */ }
          try { p?.gainNode?.disconnect?.(); } catch { /* ignore */ }
        });
      } catch { /* ignore */ }
      audioPipeByKey.clear();
      directStreamByKey.clear();
      try {
        if (playbackAudioCtx && playbackAudioCtx.state !== "closed") playbackAudioCtx.close?.();
      } catch { /* ignore */ }
      playbackAudioCtx = null;
      userVolumePctByUserId.clear();
      releaseAllRosterMeterClones();

      try { localMicStream?.getTracks?.().forEach((t) => t.stop()); } catch { /* ignore */ }
      localMicStream = null;

      try { sfuWs?.close?.(); } catch { /* ignore */ }
      sfuWs = null;

      if (speakingTimer) {
        clearInterval(speakingTimer);
        speakingTimer = null;
      }
      try {
        if (audioCtx && audioCtx.state !== "closed") audioCtx.close?.();
      } catch {
        /* ignore */
      }
      audioCtx = null;
      try {
        if (playbackAudioCtx && playbackAudioCtx.state !== "closed") playbackAudioCtx.close?.();
      } catch {
        /* ignore */
      }
      playbackAudioCtx = null;
      speakingAnalysers.clear();
      rosterSpeakingExpiryMs.clear();
      rosterSpeakingFromServer = new Set();
      uninstallGestureMediaUnlock();
      uninstallSfuVisibilityRecovery();
      if (recvTransportRecoveryTimer) {
        clearTimeout(recvTransportRecoveryTimer);
        recvTransportRecoveryTimer = null;
      }
      stopPlaybackHeal();
      stopAudioCtxKeepAlive();
      stopSfuWsPing();
      if (audioCtxUnlockHandler) {
        try { window.removeEventListener("pointerdown", audioCtxUnlockHandler); } catch { /* ignore */ }
        try { window.removeEventListener("keydown", audioCtxUnlockHandler); } catch { /* ignore */ }
        audioCtxUnlockHandler = null;
      }
      rmsScratchByFft.clear();

      voiceFsm.transition("idle", "destroy");
      setState({
        connected: false,
        joining: false,
        mediaLinkReady: true,
        room: "",
        peers: 0,
        muted: false,
        deafened: false,
        remotePeerUserIds: [],
        rosterUserIds: []
      });
    }
  };
}