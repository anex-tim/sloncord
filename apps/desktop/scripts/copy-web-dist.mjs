import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const src = path.resolve(root, "..", "web", "dist");
const dest = path.resolve(root, "dist-web");

if (!fs.existsSync(src)) {
  console.error(`Web dist not found: ${src}\nRun: npm run build --prefix ../../apps/web`);
  process.exit(1);
}

/**
 * В dist попадает public/ целиком; туда же publish-to-web кладёт Sloncord-Setup-x64.exe.
 * Класть установщик внутрь следующего .exe = рекурсия и размер 500+ МБ. В рантайме десктоп
 * обновления качает с GitHub Releases; локальный .exe в пакете не нужен.
 */
function shouldCopyToDesktopDist(sourcePath) {
  const b = path.basename(sourcePath);
  const lower = b.toLowerCase();
  if (lower.endsWith(".exe")) return false;
  if (lower.endsWith(".blockmap")) return false;
  if (lower.endsWith(".7z") && lower.includes("nsis")) return false;
  return true;
}

fs.rmSync(dest, { recursive: true, force: true });
fs.cpSync(src, dest, {
  recursive: true,
  filter: (s) => shouldCopyToDesktopDist(s),
});

/** Vite ставит crossorigin на module-скрипты — на sloncord:// это ломает загрузку (серый экран). */
const indexPath = path.join(dest, "index.html");
if (fs.existsSync(indexPath)) {
  const html = fs.readFileSync(indexPath, "utf8").replace(/\s+crossorigin(="[^"]*")?/gi, "");
  fs.writeFileSync(indexPath, html);
}

console.log(`Copied web dist → ${dest} (без *.exe / NSIS-артефактов в downloads/)`);
