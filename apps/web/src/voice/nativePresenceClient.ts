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
    return new Promise((resolve, reject) => {
      if (opts.isDestroyed()) {
        reject(new Error("destroyed"));
        return;
      }
      replacingSocket = true;
      try {
        ws?.close();
      } catch {
        /* ignore */
      }
      ws = new WebSocket(url);
      ws.onopen = () => {
        replacingSocket = false;
        send({ type: "joinRoom", roomId: opts.roomId, mode: "native" });
        resolve();
      };
      ws.onerror = () => {
        replacingSocket = false;
        reject(new Error("voice_ws_error"));
      };
      ws.onclose = (ev) => {
        if (replacingSocket || closedByUs || opts.isDestroyed()) {
          replacingSocket = false;
          return;
        }
        if (ev.code === 1000 && String(ev.reason || "").toLowerCase() === "replaced") {
          opts.onForceLeave();
          return;
        }
        scheduleReconnect();
      };
      ws.onmessage = (ev) => {
        try {
          const msg = JSON.parse(String(ev.data || "")) as Record<string, unknown>;
          handleMessage(msg);
        } catch {
          /* ignore */
        }
      };
    });
  }

  function close() {
    closedByUs = true;
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
