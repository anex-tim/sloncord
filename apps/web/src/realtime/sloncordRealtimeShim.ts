/**
 * Drop-in replacement for @microsoft/signalr HubConnection (Sloncord /ws/realtime, variant C).
 */
import { buildBackendWsUrl } from "../config/apiBase";

export enum LogLevel {
  Trace = 0,
  Debug = 1,
  Information = 2,
  Warning = 3,
  Error = 4,
  Critical = 5,
  None = 6,
}

export enum HubConnectionState {
  Disconnected = "Disconnected",
  Connected = "Connected",
  Connecting = "Connecting",
  Reconnecting = "Reconnecting",
}

type Handler = (...args: unknown[]) => void;

class SloncordHubConnection {
  private token = "";
  private ws: WebSocket | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempt = 0;
  private closed = false;
  private connectGeneration = 0;
  private connState: HubConnectionState = HubConnectionState.Disconnected;
  private readonly handlers = new Map<string, Handler>();
  private onReconnectingCb: Handler | null = null;
  private onReconnectedCb: Handler | null = null;
  private onCloseCb: Handler | null = null;
  private gotReadyAfterConnect = false;

  configure(token: string) {
    this.token = token;
  }

  on(event: string, fn: Handler) {
    this.handlers.set(event, fn);
  }

  onreconnecting(fn: Handler) {
    this.onReconnectingCb = fn;
  }

  onreconnected(fn: Handler) {
    this.onReconnectedCb = fn;
  }

  onclose(fn: Handler) {
    this.onCloseCb = fn;
  }

  get state(): HubConnectionState {
    return this.connState;
  }

  private setConnState(next: HubConnectionState) {
    this.connState = next;
  }

  private dispatchEvent(name: string, payload: unknown) {
    try {
      this.handlers.get(name)?.(payload);
    } catch {
      /* ignore */
    }
  }

  private startPing() {
    this.stopPing();
    this.pingTimer = setInterval(() => {
      try {
        this.ws?.send(JSON.stringify({ op: "ping" }));
      } catch {
        /* ignore */
      }
    }, 25000);
  }

  private stopPing() {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = null;
  }

  private scheduleReconnect() {
    if (this.closed) return;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.setConnState(HubConnectionState.Reconnecting);
    try {
      this.onReconnectingCb?.();
    } catch {
      /* ignore */
    }
    this.reconnectAttempt += 1;
    const waitMs = Math.min(30000, 500 + this.reconnectAttempt * 800);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connectInternal(true).catch(() => {
        /* onclose already schedules the next attempt */
      });
    }, waitMs);
  }

  private async connectInternal(isReconnect: boolean): Promise<void> {
    if (this.closed || !this.token) return;
    this.setConnState(HubConnectionState.Connecting);
    this.gotReadyAfterConnect = false;
    const url = buildBackendWsUrl("/ws/realtime", this.token);
    const generation = ++this.connectGeneration;

    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (err?: Error) => {
        if (settled) return;
        settled = true;
        if (err) reject(err);
        else resolve();
      };
      const previous = this.ws;
      this.ws = null;
      try {
        previous?.close();
      } catch {
        /* ignore */
      }
      const ws = new WebSocket(url);
      this.ws = ws;

      ws.onopen = () => {
        if (generation !== this.connectGeneration) return;
        this.startPing();
        this.setConnState(HubConnectionState.Connected);
        this.reconnectAttempt = 0;
        finish();
      };

      // onerror is always followed by onclose. A raw code here became an unhandled
      // rejection on every reconnect and looked like a user-facing error.
      ws.onerror = () => {};

      ws.onclose = () => {
        if (this.ws !== ws) return;
        this.stopPing();
        if (!settled) finish(new Error("realtime_disconnected"));
        if (this.closed) {
          this.setConnState(HubConnectionState.Disconnected);
          try {
            this.onCloseCb?.();
          } catch {
            /* ignore */
          }
          return;
        }
        this.scheduleReconnect();
      };

      ws.onmessage = (ev) => {
        try {
          const msg = JSON.parse(String(ev.data || "")) as { op?: string; name?: string; payload?: unknown };
          if (msg.op === "event" && msg.name) {
            this.dispatchEvent(msg.name, msg.payload);
          }
          if (msg.op === "ready") {
            if (isReconnect && !this.gotReadyAfterConnect) {
              this.gotReadyAfterConnect = true;
              try {
                this.onReconnectedCb?.();
              } catch {
                /* ignore */
              }
            }
          }
        } catch {
          /* ignore */
        }
      };
    });
  }

  async start(): Promise<void> {
    this.closed = false;
    await this.connectInternal(false);
  }

  async stop(): Promise<void> {
    this.closed = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.stopPing();
    try {
      this.ws?.close();
    } catch {
      /* ignore */
    }
    this.ws = null;
    this.setConnState(HubConnectionState.Disconnected);
  }

  async invoke(method: string, ...args: unknown[]): Promise<void> {
    if (this.state !== HubConnectionState.Connected || !this.ws) return;
    if (method === "ResyncGroups") {
      this.ws.send(JSON.stringify({ op: "resyncGroups" }));
      return;
    }
    if (method === "Typing") {
      const channelId = args[0];
      if (channelId == null) return;
      this.ws.send(JSON.stringify({ op: "typing", channelId: String(channelId) }));
    }
  }
}

export class HubConnectionBuilder {
  private token = "";

  withUrl(url: string, _opts?: unknown) {
    try {
      const u = new URL(url);
      this.token = u.searchParams.get("access_token") || "";
    } catch {
      const m = url.match(/access_token=([^&]+)/);
      this.token = m ? decodeURIComponent(m[1]) : "";
    }
    return this;
  }

  withAutomaticReconnect(_delays?: unknown) {
    return this;
  }

  configureLogging(_level: LogLevel) {
    return this;
  }

  build(): SloncordHubConnection {
    const c = new SloncordHubConnection();
    c.configure(this.token);
    return c;
  }
}
