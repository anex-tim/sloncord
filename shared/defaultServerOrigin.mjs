/**
 * Единый origin бэкенда без домена (переопределение при сборке/деплое: SLONCORD_SERVER_ORIGIN).
 * @type {string}
 */
export const DEFAULT_SLONCORD_SERVER_ORIGIN = String(
  process.env.SLONCORD_SERVER_ORIGIN || "https://136.234.12.106"
).replace(/\/$/, "");
