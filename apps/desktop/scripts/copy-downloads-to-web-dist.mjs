/**
 * Копирует apps/web/public/downloads → apps/web/dist/downloads.
 * Нужен после publish-to-web.mjs, чтобы заливать на сервер только установщик без полного Vite.
 * Требуется, чтобы apps/web/dist уже существовал (после предыдущей сборки веба).
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const webRoot = path.join(__dirname, "..", "..", "web");
const distRoot = path.join(webRoot, "dist");
const src = path.join(webRoot, "public", "downloads");
const dest = path.join(webRoot, "dist", "downloads");

if (!fs.existsSync(path.join(distRoot, "index.html"))) {
  console.error(
    "sloncord: нет apps/web/dist — сначала соберите веб один раз: npm run build:web (из корня) или полный deploy."
  );
  process.exit(1);
}
if (!fs.existsSync(src)) {
  console.error("sloncord: нет apps/web/public/downloads — сначала выполните publish-to-web (сборка .exe).");
  process.exit(1);
}

fs.mkdirSync(dest, { recursive: true });
let n = 0;
for (const name of fs.readdirSync(src)) {
  const from = path.join(src, name);
  if (!fs.statSync(from).isFile()) continue;
  fs.copyFileSync(from, path.join(dest, name));
  n += 1;
}
console.log(`sloncord: public/downloads → apps/web/dist/downloads (${n} файл(ов))`);
