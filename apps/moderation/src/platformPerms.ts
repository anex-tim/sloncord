export type PlatformPermKey =
  | "viewUsers"
  | "banUsers"
  | "muteChat"
  | "revokeSessions"
  | "viewServers"
  | "deleteServers"
  | "viewChats"
  | "viewDms"
  | "searchMessages"
  | "deleteMessages"
  | "viewReports"
  | "viewAudit"
  | "permanentBan"
  | "viewServerLogs"
  | "viewUserActivity"
  | "viewUserIps"
  | "banIps"
  | "clearUserActivity"
  | "approveAccounts";

export type PlatformPermDef = {
  key: PlatformPermKey;
  label: string;
  requires?: PlatformPermKey;
};

export const PLATFORM_PERM_DEFS: PlatformPermDef[] = [
  { key: "viewUsers", label: "Просмотр списка пользователей" },
  { key: "approveAccounts", label: "Одобрять аккаунты", requires: "viewUsers" },
  { key: "banUsers", label: "Заблокировать аккаунт", requires: "viewUsers" },
  { key: "muteChat", label: "Заблокировать чат", requires: "viewUsers" },
  { key: "revokeSessions", label: "Завершать сессии пользователей", requires: "viewUsers" },
  { key: "permanentBan", label: "Возможность вечной блокировки", requires: "banUsers" },
  { key: "viewServers", label: "Просмотр списка серверов" },
  { key: "deleteServers", label: "Удаление серверов", requires: "viewServers" },
  { key: "viewChats", label: "Просмотр чатов" },
  { key: "viewDms", label: "Просмотр личных сообщений", requires: "viewChats" },
  { key: "searchMessages", label: "Поиск сообщений" },
  { key: "deleteMessages", label: "Удаление сообщений" },
  { key: "viewReports", label: "Просмотр жалоб" },
  { key: "viewAudit", label: "Просмотр журнала действий" },
  { key: "viewServerLogs", label: "Просмотр логов сервера" },
  { key: "viewUserActivity", label: "Журнал действий пользователя", requires: "viewUsers" },
  { key: "viewUserIps", label: "Просмотр IP пользователей", requires: "viewUsers" },
  { key: "banIps", label: "Блокировка по IP", requires: "permanentBan" },
  { key: "clearUserActivity", label: "Очистка журнала действий пользователей", requires: "viewUserActivity" },
];

export type PlatformMe = {
  userId: string;
  login: string;
  nickname: string;
  isRoot: boolean;
  isPlatformModerator: boolean;
  permissions: PlatformPermKey[];
  permissionDefs?: PlatformPermDef[];
};

export function isRootUser(user: { login?: string; isPlatformRoot?: boolean } | null | undefined): boolean {
  if (!user) return false;
  return user.isPlatformRoot === true;
}

export function isRootMessage(msg: { senderIsPlatformRoot?: boolean } | null | undefined): boolean {
  return !!msg?.senderIsPlatformRoot;
}

export function canModerateUser(
  me: PlatformMe | null | undefined,
  user: { login?: string; isPlatformRoot?: boolean } | null | undefined
): boolean {
  if (!user) return false;
  if (isRootUser(user) && !me?.isRoot) return false;
  return true;
}

export function canModerateMessage(
  me: PlatformMe | null | undefined,
  msg: { senderIsPlatformRoot?: boolean } | null | undefined
): boolean {
  if (!msg) return false;
  if (isRootMessage(msg) && !me?.isRoot) return false;
  return true;
}

export function hasPerm(me: PlatformMe | null | undefined, key: PlatformPermKey): boolean {
  if (!me) return false;
  if (me.isRoot) return true;
  return me.permissions.includes(key);
}

export function canEnablePerm(selected: Set<PlatformPermKey>, key: PlatformPermKey): boolean {
  const def = PLATFORM_PERM_DEFS.find((d) => d.key === key);
  if (!def?.requires) return true;
  return selected.has(def.requires);
}

export function sanitizePerms(keys: PlatformPermKey[]): PlatformPermKey[] {
  const set = new Set(keys);
  for (const def of PLATFORM_PERM_DEFS) {
    if (def.requires && set.has(def.key) && !set.has(def.requires)) set.delete(def.key);
  }
  if (!set.has("banUsers")) set.delete("permanentBan");
  if (!set.has("permanentBan")) set.delete("banIps");
  if (!set.has("viewUsers")) {
    set.delete("viewUserActivity");
    set.delete("viewUserIps");
    set.delete("clearUserActivity");
  }
  if (!set.has("viewUserActivity")) set.delete("clearUserActivity");
  if (!set.has("viewServers")) set.delete("deleteServers");
  if (!set.has("viewChats")) set.delete("viewDms");
  if (!set.has("viewUsers")) {
    set.delete("banUsers");
    set.delete("muteChat");
    set.delete("revokeSessions");
    set.delete("permanentBan");
    set.delete("approveAccounts");
  }
  return PLATFORM_PERM_DEFS.map((d) => d.key).filter((k) => set.has(k));
}

export function canResolveReportOption(
  me: PlatformMe | null | undefined,
  option: "deleteMessage" | "banUser" | "muteChat" | "permanentBan"
): boolean {
  if (option === "deleteMessage") return hasPerm(me, "deleteMessages");
  if (option === "banUser") return hasPerm(me, "banUsers");
  if (option === "muteChat") return hasPerm(me, "muteChat");
  if (option === "permanentBan") return hasPerm(me, "permanentBan");
  return false;
}
