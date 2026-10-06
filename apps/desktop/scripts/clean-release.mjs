/**
 * Полностью очищает apps/desktop/release/ (в т.ч. старые pkg-*).
 * Сборка по умолчанию пишет в release/pkg-<time> и обычно не требует clean перед билдом.
 * На Windows EPERM у Node fs.rm — часто индекс поиска, Defender, десктоп OneDrive.
 * Сначала пробуем переименовать папку (как правило, не требует снятия блокировок с каждого файла),
 * затем cmd rmdir, затем fs.rmSync.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { platform } from "node:os";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const desktopRoot = path.join(__dirname, "..");
const release = path.join(desktopRoot, "release");

if (!fs.existsSync(release)) {
  process.exit(0);
}

const absRelease = path.resolve(release);
const isWin = platform() === "win32";

/**
 * @param {string} target
 */
function rmNode(target) {
  fs.rmSync(target, { recursive: true, force: true });
}

/**
 * @param {string} target
 */
function tryRmdirCmd(target) {
  const r = spawnSync("cmd.exe", ["/d", "/s", "/c", "rmdir", "/s", "/q", target], {
    encoding: "utf8",
    windowsVerbatimArguments: true,
  });
  return r.status === 0;
}

if (isWin) {
  const backup = path.join(desktopRoot, `release-removed-${Date.now()}.bak`);
  let renamed = false;
  try {
    fs.renameSync(absRelease, backup);
    renamed = true;
    // eslint-disable-next-line no-console
    console.log("sloncord: папка release/ переименована — electron-builder создаст новую release/.");
  } catch {
    /* сразу удаляем на месте */
  }

  if (renamed) {
    if (tryRmdirCmd(backup)) {
      // eslint-disable-next-line no-console
      console.log("sloncord: старая сборка (release-…bak) удалена (rmdir).");
    } else {
      try {
        rmNode(backup);
        // eslint-disable-next-line no-console
        console.log("sloncord: старая сборка удалена (Node).");
      } catch {
        // eslint-disable-next-line no-console
        console.warn(
          `sloncord: не удалось сразу снести ${backup} — не мешает сборке; сотрите папку позже вручную.`
        );
      }
    }
    process.exit(0);
  }

  if (tryRmdirCmd(absRelease)) {
    // eslint-disable-next-line no-console
    console.log("sloncord: папка release/ удалена (cmd rmdir).");
    process.exit(0);
  }
  try {
    rmNode(absRelease);
    // eslint-disable-next-line no-console
    console.log("sloncord: папка release/ удалена (Node).");
    process.exit(0);
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error(
      "sloncord: не удаётся очистить release/ (в т.ч. EPERM). Удалите вручную папку:"
    );
    // eslint-disable-next-line no-console
    console.error(`  ${absRelease}`);
    // eslint-disable-next-line no-console
    console.error(
      "  Помогает: исключение папки из срочного сканирования Windows Defender, отключение индекса для папки, OneDrive/синхронизация не на рабочем столе, перезагрузка."
    );
    // eslint-disable-next-line no-console
    console.error(String(e?.message || e));
    process.exit(1);
  }
} else {
  try {
    rmNode(absRelease);
    // eslint-disable-next-line no-console
    console.log("sloncord: папка release/ очищена перед сборкой.");
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error("sloncord: не удалось удалить release/");
    // eslint-disable-next-line no-console
    console.error(String(e?.message || e));
    process.exit(1);
  }
}
