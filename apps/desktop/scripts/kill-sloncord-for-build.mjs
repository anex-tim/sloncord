/**
 * Перед electron-builder: завершает только Sloncord.exe (тест из release\win-unpacked).
 * Не трогаем electron.exe — иначе закроются Cursor, VS Code, Discord и т.д.
 * «Процесс не найден» — нормально.
 */
import { spawnSync } from "node:child_process";
import { platform } from "node:os";

if (platform() !== "win32") {
  process.exit(0);
}

spawnSync("taskkill", ["/F", "/IM", "Sloncord.exe", "/T"], { stdio: "ignore", windowsHide: true });

await new Promise((r) => setTimeout(r, 2000));
// eslint-disable-next-line no-console
console.log("sloncord: пауза 2 c после снятия Sloncord (если был) — дальше electron-builder…");
