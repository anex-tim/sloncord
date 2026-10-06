/**
 * Удаляет повреждённый кэш winCodeSign (electron-builder часто падает на симлинках darwin/*.dylib на Windows).
 * Если сборка снова качает архив и падает — включите «Режим разработчика» в параметрах Windows
 * (разрешение создавать симлинки без администратора) или очистите кэш и перезапустите сборку из
 * терминала с правами администратора один раз.
 */
import fs from "node:fs";
import path from "node:path";

const base =
  process.platform === "win32"
    ? process.env.LOCALAPPDATA
    : process.platform === "darwin"
      ? path.join(process.env.HOME || "", "Library", "Caches")
      : process.env.XDG_CACHE_HOME || path.join(process.env.HOME || "", ".cache");

if (!base) {
  console.error("clean-electron-builder-cache: cannot resolve cache root");
  process.exit(1);
}

const dirs = [
  path.join(base, "electron-builder", "Cache", "winCodeSign"),
];

for (const dir of dirs) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
    console.log(`removed: ${dir}`);
  } catch (e) {
    console.warn(`skip ${dir}:`, e instanceof Error ? e.message : e);
  }
}
