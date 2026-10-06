/**
 * Копирует свежий NSIS .exe в apps/web/public/downloads и пишет moderation-release.json
 * (версия из package.json, стабильное имя Sloncord-Moderation-Setup-x64.exe).
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const modRoot = path.join(__dirname, "..");
const pkg = JSON.parse(fs.readFileSync(path.join(modRoot, "package.json"), "utf8"));
const version = String(pkg.version || "0.0.0");
const releaseRoot = path.join(modRoot, "release");
const outDir = path.join(modRoot, "..", "web", "public", "downloads");
const stableName = "Sloncord-Moderation-Setup-x64.exe";

/**
 * @returns {string | null}
 */
function findLatestPackDirectory() {
  const marker = path.join(releaseRoot, ".slonmod-last-pack-dir");
  if (fs.existsSync(marker)) {
    try {
      const p = fs.readFileSync(marker, "utf8").trim();
      if (p && fs.existsSync(p) && fs.statSync(p).isDirectory()) return path.resolve(p);
    } catch {
      /* ignore */
    }
  }
  if (!fs.existsSync(releaseRoot)) return null;
  let bestDir = null;
  let bestMtime = 0;
  for (const name of fs.readdirSync(releaseRoot)) {
    if (!name.startsWith("pkg-")) continue;
    const d = path.join(releaseRoot, name);
    try {
      if (!fs.statSync(d).isDirectory()) continue;
    } catch {
      continue;
    }
    let dirM = 0;
    try {
      dirM = fs.statSync(d).mtimeMs;
    } catch {
      dirM = 0;
    }
    if (dirM >= bestMtime) {
      bestMtime = dirM;
      bestDir = d;
    }
  }
  return bestDir;
}

/**
 * @param {string} dir
 * @returns {{ path: string; name: string } | null}
 */
function findNewestInstallerExe(dir) {
  if (!fs.existsSync(dir)) return null;
  const files = fs
    .readdirSync(dir)
    .filter((f) => /\.exe$/i.test(f) && !/blockmap/i.test(f) && !/uninstall/i.test(f));
  if (files.length === 0) return null;
  const withMtime = files.map((f) => {
    const p = path.join(dir, f);
    return { f, p, m: fs.statSync(p).mtimeMs };
  });
  withMtime.sort((a, b) => b.m - a.m);
  return { path: withMtime[0].p, name: withMtime[0].f };
}

let releaseDir = findLatestPackDirectory();
let hit = releaseDir ? findNewestInstallerExe(releaseDir) : null;

if (!hit && fs.existsSync(releaseRoot)) {
  hit = findNewestInstallerExe(releaseRoot);
  releaseDir = releaseRoot;
}

if (!hit) {
  // eslint-disable-next-line no-console
  console.error(
    "slonmod: не найден .exe установщика — сначала выполните сборку Windows (electron-builder --win)."
  );
  process.exit(1);
}

const sourcePath = hit.path;
const sourceName = hit.name;

fs.mkdirSync(outDir, { recursive: true });
const destPath = path.join(outDir, stableName);
fs.copyFileSync(sourcePath, destPath);
const st = fs.statSync(destPath);
const releasedAt = new Date().toISOString();
const meta = {
  version,
  available: true,
  fileName: stableName,
  downloadUrl: `/downloads/${stableName}`,
  size: st.size,
  releasedAt,
  buildFileName: sourceName,
};

fs.writeFileSync(path.join(outDir, "moderation-release.json"), `${JSON.stringify(meta, null, 2)}\n`, "utf8");
// eslint-disable-next-line no-console
console.log(
  `slonmod: веб-артефакты обновлены: ${stableName} → apps/web/public/downloads/ (${version}, ${st.size} байт, из ${releaseDir}${path.sep}${sourceName})`
);
