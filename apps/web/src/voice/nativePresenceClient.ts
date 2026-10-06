import { buildBackendWsUrl } from "../config/apiBase";
import type { VoiceSessionStateApi } from "./voiceSessionState";

export type NativePresenceClientOptions = {
  token: string;
  roomId: string;
  isDestroyed: () => boolean;
  voiceFsm: VoiceSessionStateApi;
  onForceLeave: () => void;
  onRoomRoster: (msg: Record<string, unknown>) => void;
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
  let pingTimer: ReturnType<typeof setInterval> | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let reconnectFailures = 0;
  /** Closing socket to open a new one — ignore onclose (avoid reconnect storm). */
  let replacingSocket = false;
  let closedByUs = false;
  let connectPromise: Promise<void> | null = null;

  function send(obj: Record<string, unknown>) {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
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

  function handleMessage(msg: Record<string, unknown>) {
    if (msg.type === "nativeReady" && String(msg.roomId || opts.roomId) === String(opts.roomId)) {
      opts.onNativeReady();
      return;
    }
    if (msg.type === "forceLeave" && String(msg.roomId) === String(opts.roomId)) {
      closedByUs = true;
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
    }
  }

  function connect(): Promise<void> {
    if (connectPromise) return connectPromise;
    connectPromise = new Promise((resolve, reject) => {
      if (opts.isDestroyed()) {
        connectPromise = null;
        reject(new Error("destroyed"));
        return;
      }
      const prev = ws;
      const socket = new WebSocket(url);
      ws = socket;
      replacingSocket = true;
      try {
        prev?.close();
      } catch {
        /* ignore */
      }

      let settled = false;
      const finishOk = () => {
        if (settled) return;
        settled = true;
        connectPromise = null;
        resolve();
      };
      const finishErr = (err: Error) => {
        if (settled) return;
        settled = true;
        connectPromise = null;
        reject(err);
      };

      socket.onopen = () => {
        if (ws !== socket) return;
        replacingSocket = false;
        send({ type: "joinRoom", roomId: opts.roomId, mode: "native" });
        finishOk();
      };
      socket.onerror = () => {
        if (ws !== socket) return;
        replacingSocket = false;
        finishErr(new Error("voice_ws_error"));
      };
      socket.onclose = (ev) => {
        // Ignore stale sockets superseded by a newer connect() (server closes them with "replaced").
        if (socket !== ws) return;
        if (replacingSocket || closedByUs || opts.isDestroyed()) {
          replacingSocket = false;
          if (!settled) finishErr(new Error("voice_ws_closed"));
          return;
        }
        if (!settled) finishErr(new Error("voice_ws_closed"));
        if (ev.code === 1000 && String(ev.reason || "").toLowerCase() === "replaced") {
          scheduleReconnect();
          return;
        }
        scheduleReconnect();
      };
      socket.onmessage = (ev) => {
        try {
          const msg = JSON.parse(String(ev.data || "")) as Record<string, unknown>;
          handleMessage(msg);
        } catch {
          /* ignore */
        }
      };
    });
    return connectPromise;
  }

  function close() {
    closedByUs = true;
    connectPromise = null;
    if (reconnectTimer) clearTimeout(reconnectTimer);
    reconnectTimer = null;
    stopPing();
    replacingSocket = true;
    try {
      send({ type: "leaveRoom" });
    } catch {
      /* ignore */
    }
    try {
      ws?.close();
    } catch {
      /* ignore */
    }
    ws = null;
    replacingSocket = false;
  }

  function startPing() {
    stopPing();
    pingTimer = setInterval(() => send({ type: "ping" }), 25000);
  }

  function stopPing() {
    if (pingTimer) clearInterval(pingTimer);
    pingTimer = null;
  }

  return { connect, send, close, startPing, stopPing };
}
