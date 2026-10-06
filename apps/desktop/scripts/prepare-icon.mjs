/**
 * SVG → resources/app-icon.png (для Electron, уведомлений, NSIS).
 * Пакет sharp: devDependency у @sloncord/desktop и в корне (workspaces), иначе ERR_MODULE_NOT_FOUND.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const monorepoRoot = path.resolve(root, "..", "..");
const svgPath = path.join(root, "..", "web", "public", "icons", "sloncord.svg");
const outDir = path.join(root, "resources");
const outPath = path.join(outDir, "app-icon.png");
const icoPath = path.join(outDir, "app-icon.ico");

/**
 * @returns {import("sharp") | null}
 */
function tryLoadSharp() {
  const candidates = [
    path.join(root, "package.json"),
    path.join(monorepoRoot, "package.json")
  ];
  for (const pkgJson of candidates) {
    if (!fs.existsSync(pkgJson)) continue;
    try {
      const req = createRequire(pkgJson);
      return req("sharp");
    } catch {
      /* next */
    }
  }
  return null;
}

function tryLoadPngToIco() {
  const candidates = [
    path.join(root, "package.json"),
    path.join(monorepoRoot, "package.json"),
  ];
  for (const pkgJson of candidates) {
    if (!fs.existsSync(pkgJson)) continue;
    try {
      const req = createRequire(pkgJson);
      return req("png-to-ico");
    } catch {
      /* next */
    }
  }
  return null;
}

async function main() {
  if (!fs.existsSync(svgPath)) {
    throw new Error(`prepare-icon: не найден ${svgPath}`);
  }
  fs.mkdirSync(outDir, { recursive: true });

  let sharp = tryLoadSharp();
  if (!sharp) {
    try {
      const m = await import("sharp");
      sharp = m.default;
    } catch {
      /* ignore */
    }
  }

  if (!sharp) {
    if (fs.existsSync(outPath) && fs.statSync(outPath).size > 32) {
      console.warn(
        "prepare-icon: пакет sharp не найден — оставляю существующий файл:\n" +
          `  ${outPath}\n` +
          "  Установите зависимости: в корне репозитория Sloncord выполните: npm install"
      );
      return;
    }
    throw new Error(
      "prepare-icon: не найден пакет sharp. В корне репозитория выполните: npm install\n" +
        "  (нужен для конвертации sloncord.svg → resources/app-icon.png)"
    );
  }

  const svgBuf = fs.readFileSync(svgPath);
  await sharp(svgBuf).resize(256, 256).png().toFile(outPath);
  console.log("prepare-icon:", outPath);

  /** png-to-ico@1.x: одна строка-путь к PNG 256×256; внутри Jimp собирает ico (16/32/48/256). */
  const pngToIco = tryLoadPngToIco();
  if (!pngToIco) {
    if (fs.existsSync(icoPath) && fs.statSync(icoPath).size > 32) {
      console.warn(
        "prepare-icon: png-to-ico не найден — оставляю существующий:\n" +
          `  ${icoPath}\n` +
          "  npm install (в корне или apps/desktop)"
      );
      return;
    }
    throw new Error(
      "prepare-icon: не найден png-to-ico — выполните npm install в корне репозитория (нужен app-icon.ico для иконки .exe и ярлыков)."
    );
  }

  const icoBuf = await pngToIco(outPath);
  fs.writeFileSync(icoPath, icoBuf);
  console.log("prepare-icon:", icoPath);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
