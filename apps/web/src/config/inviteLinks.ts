import { DEFAULT_SLONCORD_SERVER_ORIGIN } from "@sloncord/server-origin";
import { getApiBase } from "./apiBase";

/** Публичный origin для ссылок-приглашений (без trailing slash). */
export function getInviteWebOrigin(): string {
  const api = getApiBase();
  if (api) {
    try {
      const u = new URL(api.includes("://") ? api : `https://${api}`);
      return u.origin;
    } catch {
      /* ignore */
    }
  }
  if (typeof window !== "undefined") {
    const { origin, protocol } = window.location;
    if (origin && protocol !== "file:") return origin;
  }
  return DEFAULT_SLONCORD_SERVER_ORIGIN;
}

/** Каноническая ссылка на сервер: https://host/invite/CODE */
export function buildServerInviteUrl(inviteCode: string): string {
  const code = String(inviteCode || "").trim();
  if (!code) return getInviteWebOrigin();
  return `${getInviteWebOrigin()}/invite/${encodeURIComponent(code)}`;
}

/** Извлекает код из sloncord-app://, ?invite= или /invite/CODE */
export function parseInviteCodeFromUrl(raw: string): string {
  const s = String(raw || "").trim();
  if (!s) return "";
  try {
    const base =
      typeof window !== "undefined" && window.location?.origin
        ? window.location.origin
        : DEFAULT_SLONCORD_SERVER_ORIGIN;
    const u = new URL(s.includes("://") ? s : `https://${s}`, base);
    if (u.protocol === "sloncord-app:") {
      if (String(u.hostname || "").toLowerCase() === "invite") {
        return String(u.searchParams.get("code") || u.searchParams.get("invite") || "").trim();
      }
      return "";
    }
    const fromQuery = String(u.searchParams.get("invite") || "").trim();
    if (fromQuery) return fromQuery;
    const m = u.pathname.match(/\/invite\/([^/?#]+)/i);
    if (m?.[1]) return decodeURIComponent(m[1]).trim();
  } catch {
    /* ignore */
  }
  return "";
}

export function isInviteUrl(raw: string): boolean {
  return !!parseInviteCodeFromUrl(raw);
}

export function normalizeInviteUrl(raw: string): string {
  const code = parseInviteCodeFromUrl(raw);
  return code ? buildServerInviteUrl(code) : raw;
}

/** Убирает invite из адресной строки после обработки. */
export function clearInviteFromBrowserUrl(): void {
  if (typeof window === "undefined") return;
  try {
    const u = new URL(window.location.href);
    u.searchParams.delete("invite");
    if (/^\/invite\/[^/]+/i.test(u.pathname)) {
      u.pathname = "/";
    }
    const next = `${u.pathname}${u.search}${u.hash}`;
    window.history.replaceState({}, "", next);
  } catch {
    /* ignore */
  }
}

const PENDING_INVITE_KEY = "sloncord_pending_invite";

export function stashPendingInviteCode(code: string): void {
  const c = String(code || "").trim();
  if (!c) return;
  try {
    sessionStorage.setItem(PENDING_INVITE_KEY, c);
  } catch {
    /* ignore */
  }
}

export function takePendingInviteCode(): string {
  try {
    const c = String(sessionStorage.getItem(PENDING_INVITE_KEY) || "").trim();
    if (c) sessionStorage.removeItem(PENDING_INVITE_KEY);
    return c;
  } catch {
    return "";
  }
}

export function captureInviteFromCurrentUrl(): string {
  if (typeof window === "undefined") return "";
  const code = parseInviteCodeFromUrl(window.location.href);
  if (code) stashPendingInviteCode(code);
  return code;
}
