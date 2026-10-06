export function getApiBase(): string {
  const fromElectron = window.slonmod?.getApiBase?.();
  if (fromElectron !== undefined && fromElectron !== null && String(fromElectron).trim()) {
    return String(fromElectron).replace(/\/$/, "");
  }
  const env = import.meta.env.VITE_API_BASE as string | undefined;
  if (env && String(env).trim()) return String(env).replace(/\/$/, "");
  if (typeof window !== "undefined" && window.location?.origin && window.location.protocol !== "file:") {
    return window.location.origin;
  }
  return "";
}

export function getToken(): string {
  try {
    return localStorage.getItem("slonmod_token") || "";
  } catch {
    return "";
  }
}

export function setToken(token: string): void {
  try {
    if (token) localStorage.setItem("slonmod_token", token);
    else localStorage.removeItem("slonmod_token");
  } catch {
    /* ignore */
  }
}

export async function api<T = unknown>(
  path: string,
  opts: { method?: string; body?: unknown } = {}
): Promise<T> {
  const base = getApiBase();
  const url = `${base}${path.startsWith("/") ? path : `/${path}`}`;
  const headers: Record<string, string> = {};
  const token = getToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  if (opts.body !== undefined) headers["Content-Type"] = "application/json";

  const res = await fetch(url, {
    method: opts.method || "GET",
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });

  const text = await res.text();
  let data: unknown = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = { error: text };
    }
  }

  if (!res.ok) {
    const body = data as { error?: string; detail?: string } | null;
    const err =
      res.status === 403
        ? body?.error || "Доступ запрещён (403). Проверьте, что ваш логин в ModeratorLogins на сервере."
        : body?.error || res.statusText || `HTTP ${res.status}`;
    const detail = body?.detail ? `: ${body.detail}` : "";
    throw new Error(String(err) + detail);
  }
  return data as T;
}

export type PlatformUser = {
  id: string;
  login: string;
  nickname: string;
  bio?: string;
  createdAtUtc?: string;
  lastSeenAtUtc?: string | null;
  isPlatformRoot?: boolean;
  isPlatformModerator?: boolean;
  platformModeratorPermissions?: string[];
  isPlatformBanned?: boolean;
  platformBannedAtUtc?: string | null;
  platformBanReason?: string;
  platformBannedUntilUtc?: string | null;
  platformBanPermanent?: boolean;
  isChatMuted?: boolean;
  chatMutedUntilUtc?: string | null;
  chatMuteReason?: string;
  serverCount?: number;
};

export const CHAT_MUTE_DURATIONS = [
  { label: "1 час", minutes: 60 },
  { label: "6 часов", minutes: 360 },
  { label: "24 часа", minutes: 1440 },
  { label: "3 дня", minutes: 4320 },
  { label: "7 дней", minutes: 10080 },
  { label: "30 дней", minutes: 43200 },
] as const;

export const PLATFORM_BAN_DURATIONS = [
  { label: "1 час", minutes: 60 },
  { label: "6 часов", minutes: 360 },
  { label: "24 часа", minutes: 1440 },
  { label: "3 дня", minutes: 4320 },
  { label: "7 дней", minutes: 10080 },
  { label: "30 дней", minutes: 43200 },
  { label: "Навсегда", minutes: 0 },
] as const;

export type PlatformServer = {
  id: string;
  name: string;
  description?: string;
  inviteCode?: string;
  ownerUserId?: string;
  ownerNickname?: string;
  channelCount?: number;
  memberCount?: number;
  createdAtUtc?: string;
};

export type PlatformFileAttachment = {
  id: string;
  originalName?: string;
  contentType?: string;
  sizeBytes?: number;
};

export type PlatformMessageHit = {
  id: string;
  channelId: string;
  channelName: string;
  channelKind: string;
  serverId?: string | null;
  serverName?: string | null;
  senderUserId: string;
  senderNickname: string;
  senderIsPlatformRoot?: boolean;
  text: string;
  isDeleted: boolean;
  createdAtUtc: string;
  file?: { id: string; originalName?: string } | null;
  attachments?: PlatformFileAttachment[];
};

export function fileKindByName(name?: string | null): "image" | "video" | "other" {
  const ext = (name || "").split(".").pop()?.toLowerCase() || "";
  if (["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg"].includes(ext)) return "image";
  if (["mp4", "webm", "ogg", "mov", "m4v", "mkv", "avi", "wmv", "ogv"].includes(ext)) return "video";
  return "other";
}

export function isImageAttachment(file: PlatformFileAttachment): boolean {
  const ct = (file.contentType || "").toLowerCase();
  if (ct.startsWith("image/")) return true;
  return fileKindByName(file.originalName) === "image";
}

export function fileContentUrl(fileId: string): string {
  const base = getApiBase();
  const token = getToken();
  const qs = token ? `?access_token=${encodeURIComponent(token)}` : "";
  return `${base}/files/${fileId}/content${qs}`;
}

export type PlatformChannel = {
  id: string;
  name: string;
  kind: string;
  serverId?: string | null;
  serverName?: string | null;
  createdAtUtc?: string;
};

export function isDirectChannel(kind?: string | null): boolean {
  const k = String(kind || "").toLowerCase();
  return k === "direct" || k === "dm";
}

/** Человекочитаемая подпись канала в списках moderation. */
export function formatChannelLabel(ch: {
  name?: string;
  kind?: string | null;
  serverName?: string | null;
}): string {
  if (isDirectChannel(ch.kind)) {
    return `DM ${ch.name || "?"}`;
  }
  if (ch.serverName) return `${ch.serverName} / #${ch.name || "?"}`;
  return `#${ch.name || "?"}`;
}

export type PlatformReport = {
  id: string;
  status: string;
  reason: string;
  createdAtUtc: string;
  resolvedAtUtc?: string | null;
  moderatorNote?: string;
  reporterUserId: string;
  reporterNickname: string;
  resolvedByNickname?: string | null;
  message?: PlatformMessageHit | null;
};

export type ServerLogEntry = {
  createdAtUtc: string;
  level: string;
  category: string;
  message: string;
  exception?: string | null;
};

export type UserActivityEntry = {
  id: string;
  action: string;
  actionLabel: string;
  details: string;
  detailsLabel?: string;
  ipAddress?: string | null;
  createdAtUtc: string;
};

export type PlatformUserIpInfo = {
  lastKnownIp?: string | null;
  lastKnownIpAtUtc?: string | null;
  sessions?: {
    id: string;
    createdAtUtc: string;
    createdFromIp?: string | null;
    lastSeenIp?: string | null;
    lastSeenAtUtc?: string | null;
  }[];
};

export type AuditEntry = {
  id: string;
  actorUserId: string;
  actorNickname: string;
  action: string;
  actionLabel?: string;
  targetType: string;
  targetId: string;
  targetLabel?: string;
  details: string;
  detailsLabel?: string;
  createdAtUtc: string;
};
