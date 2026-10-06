import * as signalR from "../../web/src/realtime/sloncordRealtimeShim";
import { getApiBase, getToken } from "./api";

export const MOD_RT = {
  PlatformReportsChanged: "platform.reports.changed",
} as const;

export type ReportsChangedPayload = {
  pendingCount?: number;
};

export type ModerationHubHandlers = {
  onReportsChanged: (pendingCount: number) => void;
  onReconnect?: () => void;
};

export function connectModerationHub(
  handlers: ModerationHubHandlers,
  opts?: { apiBase?: string; token?: string }
): () => void {
  let stopped = false;
  let connection: signalR.HubConnection | null = null;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  const handlersRef = { current: handlers };
  handlersRef.current = handlers;

  const clearRetry = () => {
    if (retryTimer) {
      clearTimeout(retryTimer);
      retryTimer = null;
    }
  };

  const scheduleRetry = (delayMs: number) => {
    clearRetry();
    if (stopped) return;
    retryTimer = setTimeout(() => {
      retryTimer = null;
      void startConnection();
    }, delayMs);
  };

  const startConnection = async () => {
    if (stopped) return;

    const token = (opts?.token ?? getToken()).trim();
    const base = (opts?.apiBase ?? getApiBase()).replace(/\/$/, "");
    if (!token || !base) return;

    if (connection) {
      try {
        await connection.stop();
      } catch {
        /* ignore */
      }
      connection = null;
    }

    const url = `${base}/ws/realtime?access_token=${encodeURIComponent(token)}`;
    connection = new signalR.HubConnectionBuilder()
      .withUrl(url, { withCredentials: false })
      .withAutomaticReconnect([0, 2000, 5000, 10000, 30000])
      .configureLogging(signalR.LogLevel.Warning)
      .build();

    connection.on(MOD_RT.PlatformReportsChanged, (payload: ReportsChangedPayload) => {
      const n = typeof payload?.pendingCount === "number" ? payload.pendingCount : 0;
      handlersRef.current.onReportsChanged(n);
    });

    connection.onreconnected(() => {
      handlersRef.current.onReconnect?.();
    });

    connection.onclose(() => {
      if (!stopped) scheduleRetry(5000);
    });

    try {
      await connection.start();
      handlersRef.current.onReconnect?.();
    } catch {
      scheduleRetry(5000);
    }
  };

  void startConnection();

  return () => {
    stopped = true;
    clearRetry();
    void connection?.stop().catch(() => {});
    connection = null;
  };
}
