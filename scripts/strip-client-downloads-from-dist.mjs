/**
 * Убирает установщики и release-json из apps/web/dist перед деплоем бэкенда (клиент — GitHub Releases).
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distDownloads = path.join(__dirname, "..", "apps", "web", "dist", "downloads");

if (!fs.existsSync(distDownloads)) {
  process.exit(0);
}

for (const name of fs.readdirSync(distDownloads)) {
  if (name === ".gitkeep") continue;
  const p = path.join(distDownloads, name);
  try {
    fs.rmSync(p, { force: true, recursive: true });
  } catch {
    /* ignore */
  }
}

console.log("sloncord: dist/downloads очищен (клиентские артефакты только на GitHub).");
