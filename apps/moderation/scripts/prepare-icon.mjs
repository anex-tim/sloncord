/**
 * sloncord-moderation.svg → resources/app-icon.png + app-icon.ico + public/app-icon.png
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const monorepoRoot = path.resolve(root, "..", "..");
const svgPath = path.join(root, "resources", "sloncord-moderation.svg");
const outDir = path.join(root, "resources");
const publicDir = path.join(root, "public");
const outPath = path.join(outDir, "app-icon.png");
const icoPath = path.join(outDir, "app-icon.ico");
const publicPath = path.join(publicDir, "app-icon.png");

function tryLoadSharp() {
  const candidates = [path.join(root, "package.json"), path.join(monorepoRoot, "package.json")];
  for (const pkgJson of candidates) {
    if (!fs.existsSync(pkgJson)) continue;
    try {
      return createRequire(pkgJson)("sharp");
    } catch {
      /* next */
    }
  }
  return null;
}

function tryLoadPngToIco() {
  const candidates = [path.join(root, "package.json"), path.join(monorepoRoot, "package.json")];
  for (const pkgJson of candidates) {
    if (!fs.existsSync(pkgJson)) continue;
    try {
      return createRequire(pkgJson)("png-to-ico");
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
  fs.mkdirSync(publicDir, { recursive: true });

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
      console.warn("prepare-icon: sharp не найден — оставляю существующий app-icon.png");
      return;
    }
    throw new Error("prepare-icon: установите sharp (npm install в корне репозитория)");
  }

  const svgBuf = fs.readFileSync(svgPath);
  await sharp(svgBuf).resize(256, 256).png().toFile(outPath);
  fs.copyFileSync(outPath, publicPath);
  console.log("prepare-icon:", outPath);
  console.log("prepare-icon:", publicPath);

  const pngToIco = tryLoadPngToIco();
  if (!pngToIco) {
    if (fs.existsSync(icoPath) && fs.statSync(icoPath).size > 32) {
      console.warn("prepare-icon: png-to-ico не найден — оставляю существующий app-icon.ico");
      return;
    }
    throw new Error("prepare-icon: установите png-to-ico");
  }

  const icoBuf = await pngToIco(outPath);
  fs.writeFileSync(icoPath, icoBuf);
  console.log("prepare-icon:", icoPath, `(${icoBuf.length} байт)`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
