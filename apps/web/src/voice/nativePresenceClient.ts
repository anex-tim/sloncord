import { buildBackendWsUrl } from "../config/apiBase";
import type { VoiceSessionStateApi } from "./voiceSessionState";

export type NativePresenceClientOptions = {
  token: string;
  roomId: string;
  isDestroyed: () => boolean;
  voiceFsm: VoiceSessionStateApi;
  onForceLeave: () => void;
  onRoomRoster: (msg: Record<string, unknown>) => void;
  onScreenFrame?: (userId: string, jpegBase64: string) => void;
  onScreenAudio?: (userId: string, pcmBase64: string) => void;
  onVoiceMove?: (channelId: string) => void;
  onNativeReady: () => void;
  onReconnectSuccess: () => void;
};

export type NativePresenceClientApi = {
  connect: () => Promise<void>;
  send: (obj: Record<string, unknown>) => void;
  close: () => void;
  startPing: () => void;
  stopPing: () => void;
};

export function createNativePresenceClient(opts: NativePresenceClientOptions): NativePresenceClientApi {
  const url = buildBackendWsUrl("/ws/voice", opts.token);
  let ws: WebSocket | null = null;
  let joinedRoomId = "";
  let pingTimer: ReturnType<typeof setInterval> | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let reconnectFailures = 0;
  let closedByUs = false;
  let connectPromise: Promise<void> | null = null;
  /** Rejects the in-flight connect() when close() runs before joinedRoom. */
  let abortConnect: (() => void) | null = null;
  /** Bumps on close()/destroy to ignore stale socket callbacks. */
  let connectGeneration = 0;

  function send(obj: Record<string, unknown>) {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    if (obj.type === "screenFrame" || obj.type === "screenAudio") {
      if (ws.bufferedAmount > 250_000) return;
    }
    try {
      ws.send(JSON.stringify(obj));
    } catch {
      /* ignore */
    }
  }

  function scheduleReconnect() {
    if (opts.isDestroyed() || closedByUs) return;
    if (reconnectTimer) clearTimeout(reconnectTimer);
    reconnectFailures += 1;
    opts.voiceFsm.transition("recovering", "presence-reconnect");
    const waitMs = Math.min(5000, 350 * 2 ** Math.min(6, reconnectFailures));
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect()
        .then(() => {
          reconnectFailures = 0;
          opts.voiceFsm.transition("connected", "presence-reconnect-ok");
          opts.onReconnectSuccess();
        })
        .catch(() => scheduleReconnect());
    }, waitMs);
  }

  function handleMessage(socket: WebSocket, msg: Record<string, unknown>, finishJoin?: () => void) {
    if (msg.type === "joinedRoom" && String(msg.roomId || "") === String(opts.roomId)) {
      if (ws === socket || !ws) {
        ws = socket;
        joinedRoomId = String(opts.roomId);
      }
      finishJoin?.();
      return;
    }
    if (msg.type === "nativeReady" && String(msg.roomId || opts.roomId) === String(opts.roomId)) {
      opts.onNativeReady();
      return;
    }
    if (msg.type === "forceLeave" && String(msg.roomId) === String(opts.roomId)) {
      closedByUs = true;
      connectGeneration += 1;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      reconnectTimer = null;
      opts.onForceLeave();
      return;
    }
    if (msg.type === "voiceMove" && msg.channelId) {
      opts.onVoiceMove?.(String(msg.channelId));
      return;
    }
    if (msg.type === "roomRoster") {
      opts.onRoomRoster(msg);
      return;
    }
    if (msg.type === "screenFrame" && msg.userId && msg.jpeg) {
      opts.onScreenFrame?.(String(msg.userId), String(msg.jpeg));
      return;
    }
    if (msg.type === "screenAudio" && msg.userId && msg.pcm) {
      opts.onScreenAudio?.(String(msg.userId), String(msg.pcm));
    }
  }

  function connect(): Promise<void> {
    if (opts.isDestroyed()) return Promise.reject(new Error("destroyed"));
    if (ws?.readyState === WebSocket.OPEN && joinedRoomId === String(opts.roomId)) {
      return Promise.resolve();
    }
    if (connectPromise) return connectPromise;

    const gen = ++connectGeneration;
    const prevWs = ws;

    connectPromise = new Promise((resolve, reject) => {
      const socket = new WebSocket(url);
      let settled = false;

      const finishOk = () => {
        if (settled || gen !== connectGeneration || opts.isDestroyed()) return;
        settled = true;
        clearTimeout(timer);
        connectPromise = null;
        ws = socket;
        joinedRoomId = String(opts.roomId);
        if (prevWs && prevWs !== socket) {
          try {
            prevWs.close();
          } catch {
            /* ignore */
          }
        }
        resolve();
      };

      const finishErr = (err: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        connectPromise = null;
        if (abortConnect) abortConnect = null;
        try {
          socket.close();
        } catch {
          /* ignore */
        }
        reject(err);
      };
      abortConnect = () => finishErr(new Error("destroyed"));

      const timer = setTimeout(() => finishErr(new Error("voice_ws_join_timeout")), 12000);

      socket.onopen = () => {
        if (gen !== connectGeneration) return;
        try {
          socket.send(
            JSON.stringify({ type: "joinRoom", roomId: opts.roomId, mode: "native" })
          );
        } catch {
          finishErr(new Error("voice_ws_send_failed"));
        }
      };

      socket.onerror = () => {
        if (gen !== connectGeneration) return;
        if (!settled) finishErr(new Error("voice_ws_error"));
      };

      socket.onclose = (ev) => {
        if (gen !== connectGeneration) return;
        if (settled && socket !== ws) return;
        if (!settled) {
          finishErr(new Error("voice_ws_closed"));
          return;
        }
        ws = null;
        joinedRoomId = "";
        if (closedByUs || opts.isDestroyed()) return;
        if (ev.code === 1000 && String(ev.reason || "").toLowerCase() === "replaced") {
          scheduleReconnect();
          return;
        }
        scheduleReconnect();
      };

      socket.onmessage = (ev) => {
        if (gen !== connectGeneration) return;
        try {
          const msg = JSON.parse(String(ev.data || "")) as Record<string, unknown>;
          handleMessage(socket, msg, finishOk);
        } catch {
          /* ignore */
        }
      };
    });

    return connectPromise;
  }

  function close() {
    closedByUs = true;
    const abort = abortConnect;
    abortConnect = null;
    connectPromise = null;
    abort?.();
    connectGeneration += 1;
    joinedRoomId = "";
    if (reconnectTimer) clearTimeout(reconnectTimer);
    reconnectTimer = null;
    stopPing();
    try {
      if (ws?.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "leaveRoom" }));
      }
    } catch {
      /* ignore */
    }
    try {
      ws?.close();
    } catch {
      /* ignore */
    }
    ws = null;
  }

  function startPing() {
    stopPing();
    pingTimer = setInterval(() => send({ type: "ping" }), 2000);
  }

  function stopPing() {
    if (pingTimer) clearInterval(pingTimer);
    pingTimer = null;
  }

  return { connect, send, close, startPing, stopPing };
}
