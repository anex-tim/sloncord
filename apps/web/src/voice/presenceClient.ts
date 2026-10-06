import { buildBackendWsUrl } from "../config/apiBase";
import type { VoiceSessionStateApi } from "./voiceSessionState";

export type PresenceClientOptions = {
  token: string;
  roomId: string;
  useVoiceGateway: () => boolean;
  isDestroyed: () => boolean;
  voiceFsm: VoiceSessionStateApi;
  onForceLeave: () => void;
  onSfuEnvelope: (body: unknown) => void;
  onSfuReady: () => void;
  onSfuBridgeRefreshed: () => void;
  onSfuError: (message: string) => void;
  onRoomRoster: (msg: Record<string, unknown>) => void;
  onPeerLeft: (msg: Record<string, unknown>) => void;
  onVoiceMove?: (channelId: string) => void;
  onReconnectSuccess: () => void;
  getScreenSharing: () => boolean;
  scheduleMediaRebuild: (reason: string, skipGatewayReconnect: boolean) => void;
  resyncProducers: (reason: string) => void;
  tryPlayRemote: () => void;
};

export type PresenceClientApi = {
  connect: () => Promise<void>;
  send: (obj: Record<string, unknown>) => void;
  close: () => void;
  getSocket: () => WebSocket | null;
  isGatewayReady: () => boolean;
  setGatewayReady: (v: boolean) => void;
  requestGatewayReconnect: () => Promise<void>;
  startPing: () => void;
  stopPing: () => void;
  startScreenHeartbeat: () => void;
  stopScreenHeartbeat: () => void;
};

export function createPresenceClient(opts: PresenceClientOptions): PresenceClientApi {
  const presenceUrl = buildBackendWsUrl("/ws/voice", opts.token);
  let presenceWs: WebSocket | null = null;
  let presencePing: ReturnType<typeof setInterval> | null = null;
  let presenceScreenHeartbeat: ReturnType<typeof setInterval> | null = null;
  let presenceReconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let presenceReconnectFailures = 0;
  let sfuGatewayReady = false;
  let pendingGatewayJoinResolve: (() => void) | null = null;
  let pendingGatewayJoinReject: ((err: Error) => void) | null = null;

  function settleGatewayJoinWait(err: Error | null) {
    if (err) {
      try { pendingGatewayJoinReject?.(err); } catch { /* ignore */ }
    } else {
      try { pendingGatewayJoinResolve?.(); } catch { /* ignore */ }
    }
    pendingGatewayJoinResolve = null;
    pendingGatewayJoinReject = null;
  }

  function send(obj: Record<string, unknown>) {
    if (!presenceWs || presenceWs.readyState !== WebSocket.OPEN) return;
    try {
      presenceWs.send(JSON.stringify(obj));
    } catch {
      /* ignore */
    }
  }

  function stopReconnect() {
    if (presenceReconnectTimer) clearTimeout(presenceReconnectTimer);
    presenceReconnectTimer = null;
  }

  function scheduleReconnect() {
    if (opts.isDestroyed()) return;
    stopReconnect();
    presenceReconnectFailures += 1;
    opts.voiceFsm.transition("recovering", "presence-reconnect");
    const exp = Math.min(6, Math.max(0, presenceReconnectFailures - 2));
    const base = presenceReconnectFailures <= 1 ? 0 : Math.round(350 * (2 ** exp));
    const jitter = Math.round(Math.random() * 250);
    const waitMs = Math.min(5000, base + jitter);
    presenceReconnectTimer = setTimeout(() => {
      presenceReconnectTimer = null;
      if (opts.isDestroyed()) return;
      connect()
        .then(() => {
          presenceReconnectFailures = 0;
          opts.voiceFsm.transition("connected", "presence-reconnect-ok");
          opts.onReconnectSuccess();
          opts.tryPlayRemote();
        })
        .catch(() => scheduleReconnect());
    }, waitMs);
  }

  function handleMessage(msg: Record<string, unknown>) {
    if (msg.type === "sfu" && msg.body) {
      opts.onSfuEnvelope(msg.body);
      return;
    }
    if (msg.type === "sfuReady" && String(msg.roomId || opts.roomId) === String(opts.roomId)) {
      sfuGatewayReady = true;
      opts.onSfuReady();
      if (opts.useVoiceGateway()) settleGatewayJoinWait(null);
      return;
    }
    if (msg.type === "sfuBridgeRefreshed") {
      sfuGatewayReady = true;
      opts.onSfuBridgeRefreshed();
      return;
    }
    if (msg.type === "sfuError") {
      if (opts.useVoiceGateway() && pendingGatewayJoinReject) {
        settleGatewayJoinWait(new Error(String(msg.error || "sfu_error")));
      }
      opts.onSfuError(String(msg.error || "sfu_error"));
      return;
    }
    if (msg.type === "forceLeave" && String(msg.roomId) === String(opts.roomId)) {
      opts.onForceLeave();
      return;
    }
    if (msg.type === "voiceMove") {
      const chId = String(msg.channelId || "");
      if (chId) {
        try { opts.onVoiceMove?.(chId); } catch { /* ignore */ }
      }
      return;
    }
    if (msg.type === "roomRoster" && String(msg.roomId) === String(opts.roomId)) {
      opts.onRoomRoster(msg);
      return;
    }
    if (msg.type === "peerLeft") {
      opts.onPeerLeft(msg);
    }
  }

  function connect(): Promise<void> {
    if (opts.isDestroyed()) return Promise.resolve();
    sfuGatewayReady = false;
    opts.voiceFsm.transition("joining", "presence-connect");
    return new Promise((resolve, reject) => {
      const s = new WebSocket(presenceUrl);
      const gateway = opts.useVoiceGateway();
      const timer = setTimeout(() => {
        try { s.close(); } catch { /* ignore */ }
        settleGatewayJoinWait(new Error("Voice gateway timeout"));
        reject(new Error("Presence WS timeout"));
      }, gateway ? 20000 : 6000);

      if (gateway) {
        pendingGatewayJoinResolve = () => {
          clearTimeout(timer);
          resolve();
        };
        pendingGatewayJoinReject = (err) => {
          clearTimeout(timer);
          reject(err);
        };
      }

      s.onopen = () => {
        if (!gateway) clearTimeout(timer);
        presenceWs = s;
        s.onmessage = (ev) => {
          try {
            const msg = JSON.parse(String(ev.data || ""));
            handleMessage(msg);
          } catch {
            /* ignore */
          }
        };
        s.onclose = () => {
          stopPing();
          stopScreenHeartbeat();
          presenceWs = null;
          sfuGatewayReady = false;
          if (!opts.isDestroyed()) {
            opts.voiceFsm.transition("degraded", "presence-ws-close");
            scheduleReconnect();
          }
        };
        send({ type: "joinRoom", roomId: opts.roomId, mode: "sfu" });
        startPing();
        startScreenHeartbeat();
        if (!gateway) {
          opts.voiceFsm.transition("connected", "presence-open");
          resolve();
        }
      };
      s.onerror = () => {
        clearTimeout(timer);
        settleGatewayJoinWait(new Error("Presence WS error"));
        reject(new Error("Presence WS error"));
      };
    });
  }

  function requestGatewayReconnect(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!presenceWs || presenceWs.readyState !== WebSocket.OPEN) {
        reject(new Error("Voice gateway не подключен"));
        return;
      }
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error("SFU gateway reconnect timeout"));
      }, 18000);
      const onMsg = (ev: MessageEvent) => {
        try {
          const msg = JSON.parse(String(ev?.data || ""));
          if (msg?.type === "sfuReady" || msg?.type === "sfuBridgeRefreshed") {
            sfuGatewayReady = true;
            cleanup();
            resolve();
          } else if (msg?.type === "sfuError") {
            cleanup();
            reject(new Error(String(msg?.error || "sfu_error")));
          }
        } catch {
          /* ignore */
        }
      };
      const cleanup = () => {
        clearTimeout(timer);
        try { presenceWs?.removeEventListener("message", onMsg); } catch { /* ignore */ }
      };
      try { presenceWs.addEventListener("message", onMsg); } catch { /* ignore */ }
      try {
        send({ type: "reconnectSfu" });
      } catch (e) {
        cleanup();
        reject(e instanceof Error ? e : new Error(String(e)));
      }
    });
  }

  function startPing() {
    if (presencePing) clearInterval(presencePing);
    presencePing = setInterval(() => send({ type: "ping" }), 12000);
  }

  function stopPing() {
    if (presencePing) clearInterval(presencePing);
    presencePing = null;
  }

  function startScreenHeartbeat() {
    if (presenceScreenHeartbeat) clearInterval(presenceScreenHeartbeat);
    presenceScreenHeartbeat = setInterval(() => {
      if (opts.isDestroyed()) return;
      send({ type: "screenShare", roomId: opts.roomId, enabled: opts.getScreenSharing() });
    }, 4000);
  }

  function stopScreenHeartbeat() {
    if (presenceScreenHeartbeat) clearInterval(presenceScreenHeartbeat);
    presenceScreenHeartbeat = null;
  }

  function close() {
    stopReconnect();
    stopPing();
    stopScreenHeartbeat();
    try { send({ type: "leaveRoom" }); } catch { /* ignore */ }
    try { presenceWs?.close(); } catch { /* ignore */ }
    presenceWs = null;
    sfuGatewayReady = false;
  }

  return {
    connect,
    send,
    close,
    getSocket: () => presenceWs,
    isGatewayReady: () => sfuGatewayReady,
    setGatewayReady: (v) => { sfuGatewayReady = !!v; },
    requestGatewayReconnect,
    startPing,
    stopPing,
    startScreenHeartbeat,
    stopScreenHeartbeat,
  };
}
