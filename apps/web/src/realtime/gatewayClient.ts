import { buildBackendWsUrl } from "../config/apiBase";

/** Unified /ws/realtime client (variant C). Mirrors SignalR hub events as { op: "event", name, payload }. */
export type RealtimeGatewayHandlers = Record<string, (payload: unknown) => void>;

export function createRealtimeGatewayClient(token: string, handlers: RealtimeGatewayHandlers) {
  let ws: WebSocket | null = null;
  let pingTimer: ReturnType<typeof setInterval> | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let closed = false;

  function connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (closed) {
        reject(new Error("closed"));
        return;
      }
      const url = buildBackendWsUrl("/ws/realtime", token);
      ws = new WebSocket(url);
      ws.onopen = () => {
        startPing();
        resolve();
      };
      ws.onerror = () => reject(new Error("realtime_ws_error"));
      ws.onclose = () => {
        stopPing();
        if (!closed) scheduleReconnect();
      };
      ws.onmessage = (ev) => {
        try {
          const msg = JSON.parse(String(ev.data || "")) as { op?: string; name?: string; payload?: unknown };
          if (msg.op === "event" && msg.name && handlers[msg.name]) handlers[msg.name](msg.payload);
        } catch {
          /* ignore */
        }
      };
    });
  }

  function scheduleReconnect() {
    if (reconnectTimer) clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect().catch(() => scheduleReconnect());
    }, 2000);
  }

  function startPing() {
    stopPing();
    pingTimer = setInterval(() => {
      try {
        ws?.send(JSON.stringify({ op: "ping" }));
      } catch {
        /* ignore */
      }
    }, 25000);
  }

  function stopPing() {
    if (pingTimer) clearInterval(pingTimer);
    pingTimer = null;
  }

  function resyncGroups() {
    try {
      ws?.send(JSON.stringify({ op: "resyncGroups" }));
    } catch {
      /* ignore */
    }
  }

  function typing(channelId: string) {
    try {
      ws?.send(JSON.stringify({ op: "typing", channelId }));
    } catch {
      /* ignore */
    }
  }

  function close() {
    closed = true;
    if (reconnectTimer) clearTimeout(reconnectTimer);
    stopPing();
    try {
      ws?.close();
    } catch {
      /* ignore */
    }
    ws = null;
  }

  return { connect, close, resyncGroups, typing };
}
