/** Base URL for Sloncord API (no trailing slash). Empty string = same origin (browser + server static). */
export function getApiBase(): string {
  if (typeof window === "undefined") return "";

  const fromElectron = window.sloncord?.getApiBase?.();
  if (fromElectron !== undefined && fromElectron !== null && String(fromElectron).trim() !== "") {
    return String(fromElectron).replace(/\/$/, "");
  }

  const env = import.meta.env.VITE_API_BASE as string | undefined;
  if (env && String(env).trim()) return String(env).replace(/\/$/, "");

  return "";
}

/**
 * WebSocket на тот же хост, что и API.
 * В Electron страница с `file://` — у `window.location.host` нет нужного домена,
 * поэтому при непустом `getApiBase()` берём хост из него (как для REST/SignalR).
 */
export function buildBackendWsUrl(path: string, token: string): string {
  const qp = `token=${encodeURIComponent(token)}`;
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  const base = getApiBase();
  if (base) {
    try {
      const u = new URL(base);
      const wsProto = u.protocol === "https:" ? "wss" : "ws";
      return `${wsProto}://${u.host}${normalizedPath}?${qp}`;
    } catch {
      /* fall through */
    }
  }
  if (typeof window !== "undefined") {
    const wsProto = window.location.protocol === "https:" ? "wss" : "ws";
    return `${wsProto}://${window.location.host}${normalizedPath}?${qp}`;
  }
  return `${normalizedPath}?${qp}`;
}
